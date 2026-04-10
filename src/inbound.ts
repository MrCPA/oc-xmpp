import { xml, type XmppClient, type XmppElement } from "@xmpp/client";

import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  createPreCryptoDirectDmAuthorizer,
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
} from "openclaw/plugin-sdk/direct-dm";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { PluginRuntime, OpenClawConfig } from "openclaw/plugin-sdk/core";

import { parseXmppJid, normalizeXmppBareJid } from "./ids.js";
import { sendXmppTextMessage } from "./send.js";
import type { XmppOmemoController } from "./omemo.js";
import type { ResolvedXmppAccount } from "./channel.js";

interface XmppGatewayContext {
  account: ResolvedXmppAccount;
  cfg: OpenClawConfig;
  omemo?: XmppOmemoController;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
  };
  setStatus?: (status: Record<string, unknown>) => void;
}

function extractText(payload: unknown): string {
  if (payload && typeof payload === "object" && "text" in payload) {
    return String((payload as any).text ?? "");
  }
  if (typeof payload === "string") return payload;
  return "";
}

function xmppMessageId(stanza: XmppElement, fallbackSeed: string): string {
  const raw = stanza.attrs.id?.trim();
  if (raw) return raw;
  return `xmpp-${fallbackSeed}-${Date.now()}`;
}

function senderDisplayName(fromBare: string, resource?: string): string {
  return resource?.trim() || fromBare;
}

function isXmppSenderAllowed(senderJid: string, allowFrom: string[]): boolean {
  const normalizedSender = normalizeXmppBareJid(senderJid);
  if (!normalizedSender) return false;

  for (const entry of allowFrom) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized === "*") return true;
    if (normalizeXmppBareJid(normalized) === normalizedSender) return true;
  }

  return false;
}

function resolveRoomAllowlist(account: ResolvedXmppAccount): string[] {
  return (account.groups.allowed ?? [])
    .map((value) => normalizeXmppBareJid(value))
    .filter((value): value is string => Boolean(value));
}

function isRoomAllowed(account: ResolvedXmppAccount, roomJid: string): boolean {
  if ((account.groups.policy ?? "allowlist") === "all") return true;
  const allowed = resolveRoomAllowlist(account);
  return allowed.includes(roomJid);
}

function resolveMucNick(account: ResolvedXmppAccount): string {
  const parsed = parseXmppJid(account.jid);
  const bare = parsed?.bare ?? account.jid;
  const at = bare.indexOf("@");
  if (at > 0) return bare.slice(0, at);
  return "openclaw";
}

function extractTimestamp(stanza: XmppElement): number {
  const delay = stanza.getChild("delay", "urn:xmpp:delay");
  const delayedStamp = delay?.attrs.stamp;
  if (delayedStamp) {
    const parsed = Date.parse(delayedStamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function extractMucRealJid(stanza: XmppElement): string | undefined {
  const x = stanza.getChild("x", "http://jabber.org/protocol/muc#user");
  const jid = x?.getChild("item")?.attrs.jid;
  return normalizeXmppBareJid(jid ?? "");
}

function wasMentioned(text: string, nick: string): boolean {
  const trimmedNick = nick.trim();
  if (!trimmedNick) return false;
  const escaped = trimmedNick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\b|[^a-z0-9_])${escaped}([,:]?\\b|$)`, "i");
  return pattern.test(text);
}

function shouldHandleRoomMessage(params: {
  account: ResolvedXmppAccount;
  roomJid: string;
  senderRealJid?: string;
  text: string;
  botNick: string;
}): { allow: boolean; wasMentioned: boolean } {
  const { account, roomJid, senderRealJid, text, botNick } = params;

  if (!isRoomAllowed(account, roomJid)) {
    return { allow: false, wasMentioned: false };
  }

  const mentioned = wasMentioned(text, botNick);
  const replyPolicy = account.groups.replyPolicy ?? "mention-only";

  if (replyPolicy === "open") {
    return { allow: true, wasMentioned: mentioned };
  }

  if (replyPolicy === "mention-only") {
    return { allow: mentioned, wasMentioned: mentioned };
  }

  if (replyPolicy === "dm-allowlist") {
    return {
      allow: Boolean(senderRealJid && isXmppSenderAllowed(senderRealJid, account.allowFrom)),
      wasMentioned: mentioned,
    };
  }

  return { allow: false, wasMentioned: mentioned };
}

async function joinConfiguredRooms(params: {
  client: XmppClient;
  account: ResolvedXmppAccount;
  log?: XmppGatewayContext["log"];
  setStatus?: XmppGatewayContext["setStatus"];
}): Promise<void> {
  const rooms = resolveRoomAllowlist(params.account);
  if (rooms.length === 0) {
    params.setStatus?.({ joinedRooms: 0 });
    return;
  }

  const nick = resolveMucNick(params.account);
  let joined = 0;

  for (const room of rooms) {
    try {
      await params.client.send(
        xml(
          "presence",
          { to: `${room}/${nick}` },
          xml("x", { xmlns: "http://jabber.org/protocol/muc" })
        )
      );
      joined += 1;
      params.log?.info?.(`[${params.account.accountId}] joined XMPP room ${room} as ${nick}`);
    } catch (error) {
      params.log?.warn?.(
        `[${params.account.accountId}] failed joining XMPP room ${room}: ${String(error)}`
      );
    }
  }

  params.setStatus?.({ joinedRooms: joined, configuredRooms: rooms.length, mucNick: nick });
}

export async function startXmppInboundLoop(
  ctx: XmppGatewayContext,
  runtime: PluginRuntime,
  client: XmppClient
): Promise<{ stop: () => Promise<void> }> {
  const botBareJid = normalizeXmppBareJid(ctx.account.jid);
  if (!botBareJid) {
    throw new Error(`Invalid configured XMPP JID: ${ctx.account.jid}`);
  }

  const botNick = resolveMucNick(ctx.account);
  const pairing = createChannelPairingController({
    core: runtime,
    channel: "xmpp",
    accountId: ctx.account.accountId,
  });

  async function resolveAccess(senderId: string, rawBody: string) {
    return resolveInboundDirectDmAccessWithRuntime({
      cfg: ctx.cfg,
      channel: "xmpp",
      accountId: ctx.account.accountId,
      dmPolicy: ctx.account.dmPolicy,
      allowFrom: ctx.account.allowFrom,
      senderId,
      rawBody,
      isSenderAllowed: isXmppSenderAllowed,
      runtime: {
        shouldComputeCommandAuthorized:
          runtime.channel.commands.shouldComputeCommandAuthorized,
        resolveCommandAuthorizedFromAuthorizers:
          runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers,
      },
      modeWhenAccessGroupsOff: "configured",
    });
  }

  const authorizeSender = createPreCryptoDirectDmAuthorizer({
    resolveAccess: async (senderId) => await resolveAccess(senderId, ""),
    issuePairingChallenge: async ({ senderId, reply }) => {
      await pairing.issueChallenge({
        senderId,
        senderIdLine: `XMPP JID: ${senderId}`,
        sendPairingReply: reply,
        onCreated: () => {
          ctx.log?.debug?.(
            `[${ctx.account.accountId}] xmpp pairing request sender=${senderId}`
          );
        },
        onReplyError: (err: unknown) => {
          ctx.log?.warn?.(
            `[${ctx.account.accountId}] xmpp pairing reply failed for ${senderId}: ${String(err)}`
          );
        },
      });
    },
    onBlocked: ({ senderId, reason }) => {
      ctx.log?.debug?.(
        `[${ctx.account.accountId}] blocked XMPP sender ${senderId} (${reason})`
      );
    },
  });

  const handleDirectMessage = async (stanza: XmppElement) => {
    const from = parseXmppJid(stanza.attrs.from ?? "");
    if (!from?.bare || from.bare === botBareJid) return;

    const encryptedResult = await ctx.omemo?.handleInboundEncryptedDm({
      from: from.bare,
      stanza,
      reply: async (text) => {
        await sendXmppTextMessage({
          client,
          to: from.bare,
          text,
          chatType: "direct",
        });
      },
    });
    if (encryptedResult?.handled) {
      if (!encryptedResult.body?.trim()) return;
      const rawBody = encryptedResult.body.trim();

      const decision = await authorizeSender({
        senderId: from.bare,
        reply: async (text) => {
          await sendXmppTextMessage({
            client,
            omemo: ctx.omemo,
            to: from.bare,
            text,
            chatType: "direct",
          });
        },
      });
      if (decision !== "allow") return;

      const resolvedAccess = await resolveAccess(from.bare, rawBody);
      if (resolvedAccess.access.decision !== "allow") {
        ctx.log?.warn?.(
          `[${ctx.account.accountId}] dropping XMPP DM after preflight drift (${from.bare}, ${resolvedAccess.access.reason})`
        );
        return;
      }

      await dispatchInboundDirectDmWithRuntime({
        cfg: ctx.cfg,
        runtime,
        channel: "xmpp",
        channelLabel: "XMPP",
        accountId: ctx.account.accountId,
        peer: { kind: "direct", id: from.bare },
        senderId: from.bare,
        senderAddress: `xmpp:${from.bare}`,
        recipientAddress: `xmpp:${botBareJid}`,
        conversationLabel: from.bare,
        rawBody,
        messageId: xmppMessageId(stanza, from.bare),
        timestamp: extractTimestamp(stanza),
        commandAuthorized: resolvedAccess.commandAuthorized,
        deliver: async (payload) => {
          const text = extractText(payload);
          if (!text.trim()) return;
          const converted = runtime.channel.text.convertMarkdownTables(
            text,
            runtime.channel.text.resolveMarkdownTableMode({
              cfg: ctx.cfg,
              channel: "xmpp",
              accountId: ctx.account.accountId,
            })
          );
          await sendXmppTextMessage({
            client,
            omemo: ctx.omemo,
            to: from.bare,
            text: converted,
            chatType: "direct",
          });
        },
        onRecordError: (err) => {
          ctx.log?.error?.(
            `[${ctx.account.accountId}] failed recording XMPP DM inbound session: ${String(err)}`
          );
        },
        onDispatchError: (err, info) => {
          ctx.log?.error?.(
            `[${ctx.account.accountId}] XMPP DM ${info.kind} reply failed: ${String(err)}`
          );
        },
      });
      return;
    }

    const rawBody = stanza.getChildText("body")?.trim() ?? "";
    if (!rawBody) return;

    const allowPlaintext = await ctx.omemo?.allowInboundPlaintextDm({
      from: from.bare,
      body: rawBody,
      reply: async (text) => {
        await sendXmppTextMessage({
          client,
          to: from.bare,
          text,
          chatType: "direct",
        });
      },
    });
    if (allowPlaintext === false) return;

    const decision = await authorizeSender({
      senderId: from.bare,
      reply: async (text) => {
        await sendXmppTextMessage({
          client,
          omemo: ctx.omemo,
          to: from.bare,
          text,
          chatType: "direct",
        });
      },
    });
    if (decision !== "allow") return;

    const resolvedAccess = await resolveAccess(from.bare, rawBody);
    if (resolvedAccess.access.decision !== "allow") {
      ctx.log?.warn?.(
        `[${ctx.account.accountId}] dropping XMPP DM after preflight drift (${from.bare}, ${resolvedAccess.access.reason})`
      );
      return;
    }

    await dispatchInboundDirectDmWithRuntime({
      cfg: ctx.cfg,
      runtime,
      channel: "xmpp",
      channelLabel: "XMPP",
      accountId: ctx.account.accountId,
      peer: { kind: "direct", id: from.bare },
      senderId: from.bare,
      senderAddress: `xmpp:${from.bare}`,
      recipientAddress: `xmpp:${botBareJid}`,
      conversationLabel: from.bare,
      rawBody,
      messageId: xmppMessageId(stanza, from.bare),
      timestamp: extractTimestamp(stanza),
      commandAuthorized: resolvedAccess.commandAuthorized,
      deliver: async (payload) => {
        const text = extractText(payload);
        if (!text.trim()) return;
        const converted = runtime.channel.text.convertMarkdownTables(
          text,
          runtime.channel.text.resolveMarkdownTableMode({
            cfg: ctx.cfg,
            channel: "xmpp",
            accountId: ctx.account.accountId,
          })
        );
        await sendXmppTextMessage({
          client,
          omemo: ctx.omemo,
          to: from.bare,
          text: converted,
          chatType: "direct",
        });
      },
      onRecordError: (err) => {
        ctx.log?.error?.(
          `[${ctx.account.accountId}] failed recording XMPP DM inbound session: ${String(err)}`
        );
      },
      onDispatchError: (err, info) => {
        ctx.log?.error?.(
          `[${ctx.account.accountId}] XMPP DM ${info.kind} reply failed: ${String(err)}`
        );
      },
    });
  };

  const handleRoomMessage = async (stanza: XmppElement) => {
    const from = parseXmppJid(stanza.attrs.from ?? "");
    if (!from?.bare) return;

    const rawBody = stanza.getChildText("body")?.trim() ?? "";
    if (!rawBody) return;
    if ((from.resource ?? "").trim() === botNick) return;

    const senderRealJid = extractMucRealJid(stanza);
    const gate = shouldHandleRoomMessage({
      account: ctx.account,
      roomJid: from.bare,
      senderRealJid,
      text: rawBody,
      botNick,
    });
    if (!gate.allow) return;

    const target = `room:${from.bare}`;
    const route = runtime.channel.routing.resolveAgentRoute({
      cfg: ctx.cfg,
      channel: "xmpp",
      accountId: ctx.account.accountId,
      peer: { kind: "channel", id: target },
    });
    const storePath = runtime.channel.session.resolveStorePath(
      ctx.cfg.session?.store,
      { agentId: route.agentId }
    );
    const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const timestamp = extractTimestamp(stanza);
    const displayFrom = senderDisplayName(senderRealJid ?? from.bare, from.resource);
    const body = runtime.channel.reply.formatAgentEnvelope({
      channel: "XMPP",
      from: displayFrom,
      timestamp,
      previousTimestamp,
      envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(ctx.cfg),
      body: rawBody,
    });
    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: rawBody,
      RawBody: rawBody,
      CommandBody: rawBody,
      From: `xmpp:${from.bare}`,
      To: target,
      SessionKey: route.sessionKey,
      AccountId: route.accountId ?? ctx.account.accountId,
      ChatType: "group",
      ConversationLabel: from.bare,
      GroupSubject: from.bare,
      GroupChannel: from.bare,
      NativeChannelId: from.bare,
      SenderName: from.resource || undefined,
      SenderId: senderRealJid ?? (from.resource ? `${from.bare}/${from.resource}` : from.bare),
      Provider: "xmpp",
      Surface: "xmpp",
      WasMentioned: gate.wasMentioned,
      MessageSid: xmppMessageId(stanza, from.bare),
      Timestamp: timestamp,
      OriginatingChannel: "xmpp",
      OriginatingTo: target,
      CommandAuthorized: true,
    });

    await dispatchInboundReplyWithBase({
      cfg: ctx.cfg,
      channel: "xmpp",
      accountId: ctx.account.accountId,
      route,
      storePath,
      ctxPayload,
      core: runtime,
      deliver: async (payload) => {
        const text = extractText(payload);
        if (!text.trim()) return;
        const converted = runtime.channel.text.convertMarkdownTables(
          text,
          runtime.channel.text.resolveMarkdownTableMode({
            cfg: ctx.cfg,
            channel: "xmpp",
            accountId: ctx.account.accountId,
          })
        );
        await sendXmppTextMessage({
          client,
          omemo: ctx.omemo,
          to: from.bare,
          text: converted,
          chatType: "channel",
        });
      },
      onRecordError: (err) => {
        ctx.log?.error?.(
          `[${ctx.account.accountId}] failed recording XMPP room inbound session: ${String(err)}`
        );
      },
      onDispatchError: (err, info) => {
        ctx.log?.error?.(
          `[${ctx.account.accountId}] XMPP room ${info.kind} reply failed: ${String(err)}`
        );
      },
    });
  };

  const onStanza = (stanza: XmppElement) => {
    if (!stanza.is("message")) return;

    const type = (stanza.attrs.type ?? "chat").toLowerCase();
    void (async () => {
      try {
        if (type === "groupchat") {
          await handleRoomMessage(stanza);
          return;
        }

        if (type === "chat" || type === "normal") {
          await handleDirectMessage(stanza);
        }
      } catch (error) {
        ctx.log?.error?.(
          `[${ctx.account.accountId}] XMPP inbound handling failed: ${String(error)}`
        );
      }
    })();
  };

  const onOnline = () => {
    void joinConfiguredRooms({
      client,
      account: ctx.account,
      log: ctx.log,
      setStatus: ctx.setStatus,
    });
  };

  client.on("stanza", onStanza);
  client.on("online", onOnline);
  await joinConfiguredRooms({
    client,
    account: ctx.account,
    log: ctx.log,
    setStatus: ctx.setStatus,
  });

  return {
    stop: async () => {
      client.removeListener("stanza", onStanza);
      client.removeListener("online", onOnline);
    },
  };
}
