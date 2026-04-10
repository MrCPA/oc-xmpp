import {
  buildChannelConfigSchema,
  createChannelPluginBase,
  createChatChannelPlugin,
  type ChannelOutboundAdapter,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";

import { startXmppTransport } from "./client.js";
import { startXmppInboundLoop } from "./inbound.js";
import {
  looksLikeXmppRoomJid,
  normalizeXmppBareJid,
  normalizeXmppConversationId,
  parseXmppTarget,
  resolveXmppSessionConversation,
} from "./ids.js";
import { getXmppRuntime } from "./runtime.js";
import type {
  ResolvedXmppOmemoConfig,
  XmppOmemoController,
} from "./omemo.js";
import { resolveXmppDeliveryTarget, sendXmppTextMessage } from "./send.js";

export interface XmppChannelConfig {
  jid?: string;
  password?: string;
  service?: string;
  chatDomain?: string;
  mucService?: string;
  mediaMaxMb?: number;
  dm?: {
    policy?: string;
    allowFrom?: string[];
  };
  groups?: {
    policy?: string;
    allowed?: string[];
    replyPolicy?: string;
  };
  omemo?: {
    mode?: "off" | "optional" | "required";
    allowUnencryptedFallback?: boolean;
    replyOnUnsupportedInbound?: boolean;
    statePath?: string;
  };
}

export interface ResolvedXmppAccount {
  accountId: string;
  jid: string;
  password: string;
  service: string;
  chatDomain?: string;
  mucService?: string;
  dmPolicy: string;
  allowFrom: string[];
  groups: {
    policy?: string;
    allowed?: string[];
    replyPolicy?: string;
  };
  omemo: ResolvedXmppOmemoConfig;
  configured: boolean;
  enabled: boolean;
}

const DEFAULT_ACCOUNT_ID = "default";

interface ActiveAccount {
  client: Awaited<ReturnType<typeof startXmppTransport>>["client"];
  omemo: XmppOmemoController;
  stop: () => Promise<void>;
}

const activeAccounts = new Map<string, ActiveAccount>();

function createDisabledOmemoController(
  config: ResolvedXmppOmemoConfig,
  statePath = ".openclaw/xmpp-omemo-disabled.json"
): XmppOmemoController {
  return {
    config,
    statePath,
    async initialize() {},
    async beforeSend() {
      return null;
    },
    async afterPlaintextSend() {},
    async handleInboundEncryptedDm() {
      return { handled: false };
    },
    async allowInboundPlaintextDm() {
      return true;
    },
    async stop() {},
  };
}

function getXmppSection(cfg: OpenClawConfig): XmppChannelConfig | undefined {
  return (cfg.channels as Record<string, any>)?.xmpp;
}

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): ResolvedXmppAccount {
  const section = getXmppSection(cfg);
  const jid = section?.jid ?? "";
  const password = section?.password ?? "";
  const service = section?.service ?? "";
  const configured = Boolean(jid && password && service);

  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    jid,
    password,
    service,
    chatDomain: section?.chatDomain,
    mucService: section?.mucService,
    dmPolicy: section?.dm?.policy ?? "allowlist",
    allowFrom: section?.dm?.allowFrom ?? [],
    groups: section?.groups ?? {},
    omemo: {
      mode: section?.omemo?.mode ?? "off",
      allowUnencryptedFallback: section?.omemo?.allowUnencryptedFallback ?? false,
      replyOnUnsupportedInbound: section?.omemo?.replyOnUnsupportedInbound ?? false,
      statePath: section?.omemo?.statePath,
    },
    configured,
    enabled: configured,
  };
}

function inspectAccount(cfg: OpenClawConfig) {
  const section = getXmppSection(cfg);
  const configured = Boolean(
    section?.jid && section?.password && section?.service
  );

  return {
    enabled: configured,
    configured,
    tokenStatus: section?.password ? "available" : ("missing" as const),
  };
}

function applySetupInput(
  cfg: OpenClawConfig,
  input: {
    userId?: string;
    token?: string;
    url?: string;
    chatDomain?: string;
    mucService?: string;
    dmAllowlist?: string[];
  }
): OpenClawConfig {
  const current = getXmppSection(cfg) ?? {};
  return {
    ...cfg,
    channels: {
      ...(cfg.channels ?? {}),
      xmpp: {
        ...current,
        jid: input.userId ?? current.jid,
        password: input.token ?? current.password,
        service: input.url ?? current.service,
        chatDomain: input.chatDomain ?? current.chatDomain,
        mucService: input.mucService ?? current.mucService,
        dm: {
          policy: current.dm?.policy ?? "allowlist",
          allowFrom: input.dmAllowlist ?? current.dm?.allowFrom ?? [],
        },
        groups: current.groups ?? {},
      },
    },
  };
}

const XMPP_META = {
  id: "xmpp",
  label: "XMPP",
  selectionLabel: "XMPP (bot/JID)",
  docsPath: "/docs/plugins/sdk-channel-plugins",
  docsLabel: "xmpp",
  blurb: "Connect OpenClaw to an XMPP server or MUC as a bot account.",
  order: 96,
} as const;

const xmppSetupAdapter = {
  resolveAccountId: () => DEFAULT_ACCOUNT_ID,
  validateInput: ({ cfg, input }: { cfg: OpenClawConfig; input: any }) => {
    const section = getXmppSection(cfg);
    const jid = input.userId ?? section?.jid;
    const password = input.token ?? section?.password;
    const service = input.url ?? section?.service;

    if (!jid || !password || !service) {
      return "XMPP setup needs userId (JID), token (password), and url (service URL).";
    }

    return null;
  },
  applyAccountConfig: ({ cfg, input }: { cfg: OpenClawConfig; input: any }) =>
    applySetupInput(cfg, {
      userId: input.userId,
      token: input.token,
      url: input.url,
      chatDomain: input.chatDomain,
      mucService: input.mucService,
      dmAllowlist: input.dmAllowlist,
    }),
};

const xmppConfigAdapter = {
  listAccountIds: (cfg: OpenClawConfig) =>
    getXmppSection(cfg)?.jid ? [DEFAULT_ACCOUNT_ID] : [],
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
    resolveAccount(cfg, accountId),
  inspectAccount: (cfg: OpenClawConfig) => inspectAccount(cfg),
  isConfigured: (account: ResolvedXmppAccount) => account.configured,
  describeAccount: (account: ResolvedXmppAccount) => ({
    accountId: account.accountId,
    configured: account.configured,
    enabled: account.enabled,
  }),
};

const XmppConfigSchema = {
  type: "object" as const,
  properties: {
    jid: { type: "string" as const },
    password: { type: "string" as const },
    service: { type: "string" as const },
    chatDomain: { type: "string" as const },
    mucService: { type: "string" as const },
    mediaMaxMb: { type: "number" as const },
    dm: {
      type: "object" as const,
      properties: {
        policy: {
          type: "string" as const,
          enum: ["allowlist", "open", "pairing"],
        },
        allowFrom: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    },
    groups: {
      type: "object" as const,
      properties: {
        policy: {
          type: "string" as const,
          enum: ["allowlist", "all"],
        },
        allowed: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        replyPolicy: {
          type: "string" as const,
          enum: ["dm-allowlist", "mention-only", "open"],
        },
      },
    },
    omemo: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string" as const,
          enum: ["off", "optional", "required"],
        },
        allowUnencryptedFallback: { type: "boolean" as const },
        replyOnUnsupportedInbound: { type: "boolean" as const },
        statePath: { type: "string" as const },
      },
    },
  },
  required: ["jid", "password", "service"] as string[],
};

const xmppOutboundAdapter: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ to, text, accountId }) => {
    const aid = accountId ?? DEFAULT_ACCOUNT_ID;
    const active = activeAccounts.get(aid);
    if (!active) {
      throw new Error(`XMPP client not running for account ${aid}`);
    }

    const trimmed = text?.trim() ?? "";
    if (!trimmed) {
      return { channel: "xmpp", messageId: "" };
    }

    const target = resolveXmppDeliveryTarget(to);
    return await sendXmppTextMessage({
      client: active.client,
      omemo: active.omemo,
      to: target.to,
      text: trimmed,
      chatType: target.chatType,
    });
  },
  sendMedia: async ({ to, text, mediaUrl, accountId }) => {
    const aid = accountId ?? DEFAULT_ACCOUNT_ID;
    const active = activeAccounts.get(aid);
    if (!active) {
      throw new Error(`XMPP client not running for account ${aid}`);
    }
    if (!mediaUrl?.trim()) {
      throw new Error("XMPP mediaUrl is required");
    }

    const target = resolveXmppDeliveryTarget(to);
    const caption = text?.trim() ?? "";
    const content = caption ? `${caption}\n\n${mediaUrl.trim()}` : mediaUrl.trim();

    return await sendXmppTextMessage({
      client: active.client,
      omemo: active.omemo,
      to: target.to,
      text: content,
      chatType: target.chatType,
    });
  },
};

export const xmppPlugin = createChatChannelPlugin({
  base: {
    ...createChannelPluginBase({
      id: "xmpp",
      meta: XMPP_META,
      reload: { configPrefixes: ["channels.xmpp"] },
      configSchema: buildChannelConfigSchema(XmppConfigSchema as any),
      setup: xmppSetupAdapter,
      config: xmppConfigAdapter,
    }),
    id: "xmpp",
    meta: XMPP_META,
    setup: xmppSetupAdapter,
    config: xmppConfigAdapter,
    capabilities: {
      chatTypes: ["direct", "channel"],
      media: false,
    },
    messaging: {
      normalizeTarget: (target: string) => normalizeXmppConversationId(target),
      targetResolver: {
        looksLikeId: (input: string) => Boolean(normalizeXmppBareJid(input)),
        hint: "<jid>, dm:<jid>, or room:<room@conference.example.com>",
      },
      parseExplicitTarget: ({ raw }: { raw: string }) => parseXmppTarget(raw),
      inferTargetChatType: ({ to }: { to: string }) => {
        if (looksLikeXmppRoomJid(to)) return "channel";
        return undefined;
      },
      resolveInboundConversation: ({
        from,
        conversationId,
        isGroup,
      }: {
        from?: string;
        conversationId?: string;
        isGroup: boolean;
      }) => {
        const resolved = normalizeXmppConversationId(conversationId ?? from ?? "");
        if (!resolved) return null;
        return {
          conversationId: resolved,
          parentConversationId: isGroup ? resolved : undefined,
        };
      },
      resolveDeliveryTarget: ({
        conversationId,
        parentConversationId,
      }: {
        conversationId: string;
        parentConversationId?: string;
      }) => {
        const to = normalizeXmppConversationId(
          parentConversationId ?? conversationId
        );
        return to ? { to } : null;
      },
      resolveSessionConversation: ({
        kind,
        rawId,
      }: {
        kind: "group" | "channel";
        rawId: string;
      }) => resolveXmppSessionConversation(kind, rawId),
    },
    gateway: {
      startAccount: async (ctx: any) => {
        const account = resolveAccount(ctx.cfg, ctx.account?.accountId);
        if (!account.configured) {
          throw new Error("XMPP credentials not configured");
        }

        ctx.setStatus?.({
          accountId: account.accountId,
          jid: account.jid,
          service: account.service,
          conversationGrammar: true,
          transportImplemented: true,
          transportState: "starting",
        });

        ctx.log?.info?.(
          `[${account.accountId}] starting XMPP provider (jid: ${account.jid})`
        );

        const existing = activeAccounts.get(account.accountId);
        if (existing) {
          ctx.log?.warn?.(
            `[${account.accountId}] stopping previous XMPP provider before restart`
          );
          await existing.stop();
          activeAccounts.delete(account.accountId);
        }

        const lifecycle = await startXmppTransport({
          account: {
            accountId: account.accountId,
            jid: account.jid,
            password: account.password,
            service: account.service,
            chatDomain: account.chatDomain,
          },
          abortSignal: ctx.abortSignal,
          log: ctx.log,
          setStatus: (status) =>
            ctx.setStatus?.({
              conversationGrammar: true,
              ...status,
            }),
        });

        let omemo: XmppOmemoController = createDisabledOmemoController(
          account.omemo,
          account.omemo.statePath
        );

        if (account.omemo.mode !== "off") {
          try {
            const { createXmppOmemoController } = await import("./omemo.js");
            omemo = await createXmppOmemoController({
              account,
              client: lifecycle.client,
              log: ctx.log,
              setStatus: (status) =>
                ctx.setStatus?.({
                  conversationGrammar: true,
                  ...status,
                }),
            });
          } catch (error) {
            const message = String(error);
            ctx.log?.error?.(
              `[${account.accountId}] XMPP OMEMO initialization failed: ${message}`
            );
            ctx.setStatus?.({
              conversationGrammar: true,
              omemoInitError: message,
            });
            if (account.omemo.mode === "required") {
              await lifecycle.stop().catch(() => undefined);
              throw error;
            }
            ctx.log?.warn?.(
              `[${account.accountId}] continuing without OMEMO because mode=${account.omemo.mode}`
            );
          }
        } else {
          ctx.log?.info?.(
            `[${account.accountId}] XMPP OMEMO disabled, skipping crypto initialization`
          );
        }

        const runtime = getXmppRuntime();
        const inbound = await startXmppInboundLoop(
          {
            account,
            cfg: ctx.cfg,
            log: ctx.log,
            omemo,
            setStatus: (status) =>
              ctx.setStatus?.({
                conversationGrammar: true,
                ...status,
              }),
          },
          runtime,
          lifecycle.client
        );

        let stopped = false;
        const stop = async () => {
          if (stopped) return;
          stopped = true;
          await inbound.stop();
          await omemo.stop();
          await lifecycle.stop();
          activeAccounts.delete(account.accountId);
          ctx.log?.info?.(`[${account.accountId}] XMPP provider stopped`);
        };

        activeAccounts.set(account.accountId, {
          client: lifecycle.client,
          omemo,
          stop,
        });
        ctx.log?.info?.(`[${account.accountId}] XMPP provider started`);

        const onAbort = () => {
          void stop().catch((error) => {
            ctx.log?.error?.(
              `[${account.accountId}] XMPP provider stop failed: ${String(error)}`
            );
          });
        };
        ctx.abortSignal?.addEventListener?.("abort", onAbort, { once: true });

        try {
          await lifecycle.done;
        } catch (err) {
          ctx.log?.error?.(
            `[${account.accountId}] XMPP transport fatal error: ${String(err)}`
          );
          throw err;
        } finally {
          ctx.abortSignal?.removeEventListener?.("abort", onAbort);
          await stop();
        }
      },
    },
  },

  security: {
    dm: {
      channelKey: "xmpp",
      resolvePolicy: (account: ResolvedXmppAccount) => account.dmPolicy,
      resolveAllowFrom: (account: ResolvedXmppAccount) => account.allowFrom,
      defaultPolicy: "allowlist",
    },
  },

  pairing: {
    text: {
      idLabel: "XMPP JID",
      message: "Your pairing request has been approved!",
      normalizeAllowEntry: (entry: string) => entry.trim().toLowerCase(),
      notify: async ({ id, message, accountId }: { id: string; message: string; accountId?: string }) => {
        const aid = accountId ?? DEFAULT_ACCOUNT_ID;
        const active = activeAccounts.get(aid);
        if (!active) return;

        await sendXmppTextMessage({
          client: active.client,
          to: normalizeXmppBareJid(id) ?? id,
          text: message,
          chatType: "direct",
        });
      },
    },
  },

  threading: { topLevelReplyToMode: "reply" },
  outbound: xmppOutboundAdapter,
});
