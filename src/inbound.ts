import { xml, type XmppClient, type XmppElement } from "@xmpp/client";

import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  createPreCryptoDirectDmAuthorizer,
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
} from "openclaw/plugin-sdk/direct-dm";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { PluginRuntime, OpenClawConfig } from "openclaw/plugin-sdk/core";

import { buildDiscoInfoResult, NS_DISCO_INFO, supportsDiscoInfoNode } from "./disco.js";
import { parseXmppJid, normalizeXmppBareJid } from "./ids.js";
import {
  createXmppMessageKey,
  extractTimestampFromDelayStamp,
  resolveDirectMessageBody,
  resolveMucNickFromJid,
  resolveXmppMessageId,
  senderDisplayName,
  shouldIgnoreDirectMessage,
  shouldIgnoreRoomMessage,
} from "./inbound-helpers.js";
import type { XmppOmemoController } from "./omemo.js";
import {
  createSeenMessageTracker,
  isXmppSenderAllowed,
  shouldHandleRoomMessage,
} from "./policy.js";
import { sendXmppTextMessage } from "./send.js";
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
  return resolveXmppMessageId({
    stanzaId: stanza.attrs.id,
    fallbackSeed,
  });
}

function resolveMucNick(account: ResolvedXmppAccount): string {
  return resolveMucNickFromJid(account.jid);
}

function extractTimestamp(stanza: XmppElement): number {
  return extractTimestampFromDelayStamp(
    stanza.getChild("delay", "urn:xmpp:delay")?.attrs.stamp
  );
}

function hasDelayStamp(stanza: XmppElement): boolean {
  return Boolean(stanza.getChild("delay", "urn:xmpp:delay")?.attrs.stamp);
}

function extractMucRealJid(stanza: XmppElement): string | undefined {
  const x = stanza.getChild("x", "http://jabber.org/protocol/muc#user");
  const jid = x?.getChild("item")?.attrs.jid;
  return normalizeXmppBareJid(jid ?? "");
}

async function joinConfiguredRooms(params: {
  client: XmppClient;
  account: ResolvedXmppAccount;
  log?: XmppGatewayContext["log"];
  setStatus?: XmppGatewayContext["setStatus"];
}): Promise<void> {
  const rooms = params.account.groups.allowed ?? [];
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
  const seenMessageIds = createSeenMessageTracker();
  const pairing = createChannelPairingController({
    core: runtime,
    channel: "xmpp",
    accountId: ctx.account.accountId,
  });

  const resolveMarkdownTableMode = () =>
    runtime.channel.text.resolveMarkdownTableMode({
      cfg: ctx.cfg,
      channel: "xmpp",
      accountId: ctx.account.accountId,
    });

  const convertOutboundText = (text: string) =>
    runtime.channel.text.convertMarkdownTables(text, resolveMarkdownTableMode());

  async function deliverText(params: {
    to: string;
    text: string;
    chatType: "direct" | "channel";
    useOmemo?: boolean;
  }) {
    const trimmed = params.text.trim();
    if (!trimmed) return;
    await sendXmppTextMessage({
      client,
      omemo: params.useOmemo === false ? undefined : ctx.omemo,
      to: params.to,
      text: convertOutboundText(trimmed),
      chatType: params.chatType,
    });
  }

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

  const dispatchDirectMessage = async (params: {
    stanza: XmppElement;
    fromBare: string;
    rawBody: string;
    commandAuthorized: boolean;
  }) => {
    await dispatchInboundDirectDmWithRuntime({
      cfg: ctx.cfg,
      runtime,
      channel: "xmpp",
      channelLabel: "XMPP",
      accountId: ctx.account.accountId,
      peer: { kind: "direct", id: params.fromBare },
      senderId: params.fromBare,
      senderAddress: `xmpp:${params.fromBare}`,
      recipientAddress: `xmpp:${botBareJid}`,
      conversationLabel: params.fromBare,
      rawBody: params.rawBody,
      messageId: xmppMessageId(params.stanza, params.fromBare),
      timestamp: extractTimestamp(params.stanza),
      commandAuthorized: params.commandAuthorized,
      deliver: async (payload) => {
        const text = extractText(payload);
        await deliverText({
          to: params.fromBare,
          text,
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

  const handleDirectMessage = async (stanza: XmppElement) => {
    const from = parseXmppJid(stanza.attrs.from ?? "");
    if (shouldIgnoreDirectMessage({ fromBare: from?.bare, botBareJid })) return;

    const encryptedResult = await ctx.omemo?.handleInboundEncryptedDm({
      from: from.bare,
      stanza,
      reply: async (text) => {
        await deliverText({
          to: from.bare,
          text,
          chatType: "direct",
          useOmemo: false,
        });
      },
    });

    const rawBody = resolveDirectMessageBody({
      encryptedHandled: Boolean(encryptedResult?.handled),
      encryptedBody: encryptedResult?.body,
      plaintextBody: stanza.getChildText("body"),
    });
    if (!rawBody) return;

    if (!encryptedResult?.handled) {
      const allowPlaintext = await ctx.omemo?.allowInboundPlaintextDm({
        from: from.bare,
        body: rawBody,
        reply: async (text) => {
          await deliverText({
            to: from.bare,
            text,
            chatType: "direct",
            useOmemo: false,
          });
        },
      });
      if (allowPlaintext === false) return;
    }

    const decision = await authorizeSender({
      senderId: from.bare,
      reply: async (text) => {
        await deliverText({
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

    await dispatchDirectMessage({
      stanza,
      fromBare: from.bare,
      rawBody,
      commandAuthorized: resolvedAccess.commandAuthorized,
    });
  };

  const handleRoomMessage = async (stanza: XmppElement) => {
    const from = parseXmppJid(stanza.attrs.from ?? "");
    const timestamp = extractTimestamp(stanza);
    const rawBody = stanza.getChildText("body")?.trim() ?? "";
    const roomDecision = shouldIgnoreRoomMessage({
      fromBare: from?.bare,
      fromResource: from?.resource,
      botNick,
      body: rawBody,
      isDelayed: hasDelayStamp(stanza),
      timestamp,
    });
    if (roomDecision.ignore) {
      if (roomDecision.reason === "delayed-history" && from?.bare) {
        ctx.log?.debug?.(
          `[${ctx.account.accountId}] ignoring delayed XMPP room history for ${from.bare}`
        );
      }
      return;
    }

    const senderRealJid = extractMucRealJid(stanza);
    const gate = shouldHandleRoomMessage({
      roomJid: from.bare,
      roomPolicy: ctx.account.groups.policy,
      allowedRooms: ctx.account.groups.allowed,
      replyPolicy: ctx.account.groups.replyPolicy,
      senderRealJid,
      dmAllowFrom: ctx.account.allowFrom,
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
        await deliverText({
          to: from.bare,
          text,
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
    if (stanza.is("iq") && String(stanza.attrs.type ?? "").toLowerCase() === "get") {
      const query = stanza.getChild("query", NS_DISCO_INFO) ?? stanza.getChild("query");
      const from = String(stanza.attrs.from ?? "").trim();
      const id = String(stanza.attrs.id ?? "").trim();
      const node = typeof query?.attrs.node === "string" ? query.attrs.node : undefined;
      if (query && from && id && supportsDiscoInfoNode(node)) {
        void client.send(
          xml("iq", { to: from, id, type: "result" }, buildDiscoInfoResult(node))
        );
      }
      return;
    }

    if (!stanza.is("message")) return;

    const from = parseXmppJid(stanza.attrs.from ?? "");
    const messageKey = createXmppMessageKey({
      fromBare: from?.bare,
      rawFrom: String(stanza.attrs.from ?? "unknown"),
      stanzaId: stanza.attrs.id,
    });
    if (!seenMessageIds.mark(messageKey)) {
      ctx.log?.debug?.(
        `[${ctx.account.accountId}] skipping duplicate XMPP message ${messageKey}`
      );
      return;
    }

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
