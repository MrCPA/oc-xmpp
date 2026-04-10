import { client as createXmppClient, xml, type XmppClient } from "@xmpp/client";

import { buildCapsElement } from "./disco.js";
import { parseXmppJid } from "./ids.js";

export interface XmppTransportAccount {
  accountId: string;
  jid: string;
  password: string;
  service: string;
  chatDomain?: string;
}

export interface XmppTransportLifecycle {
  client: XmppClient;
  done: Promise<void>;
  stop: () => Promise<void>;
}

interface StartXmppTransportParams {
  account: XmppTransportAccount;
  abortSignal?: AbortSignal;
  createClient?: typeof createXmppClient;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
  };
  setStatus?: (status: Record<string, unknown>) => void;
}

function splitLocalAndDomain(bareJid: string): {
  username: string;
  domain: string;
} {
  const at = bareJid.indexOf("@");
  if (at <= 0 || at === bareJid.length - 1) {
    throw new Error(`XMPP JID must include localpart and domain: ${bareJid}`);
  }

  return {
    username: bareJid.slice(0, at),
    domain: bareJid.slice(at + 1),
  };
}

function summarizeStanza(stanza: {
  attrs?: Record<string, unknown>;
  getChildText?: (name: string) => string | undefined;
  is?: (name: string) => boolean;
}): string {
  const from = typeof stanza.attrs?.from === "string" ? stanza.attrs.from : "unknown";
  const to = typeof stanza.attrs?.to === "string" ? stanza.attrs.to : "unknown";
  const id = typeof stanza.attrs?.id === "string" ? stanza.attrs.id : "";
  const type = typeof stanza.attrs?.type === "string" ? stanza.attrs.type : "";
  const body = typeof stanza.getChildText === "function" ? stanza.getChildText("body")?.trim() ?? "" : "";
  const bodyPreview = body ? ` body=${JSON.stringify(body.slice(0, 120))}` : "";
  return `kind=${stanza.is?.("message") ? "message" : stanza.is?.("presence") ? "presence" : "stanza"} from=${from} to=${to}${id ? ` id=${id}` : ""}${type ? ` type=${type}` : ""}${bodyPreview}`;
}

export async function startXmppTransport(
  params: StartXmppTransportParams
): Promise<XmppTransportLifecycle> {
  const { account, abortSignal, createClient = createXmppClient, log, setStatus } = params;
  const parsed = parseXmppJid(account.jid);
  if (!parsed) {
    throw new Error(`Invalid XMPP JID: ${account.jid}`);
  }

  const { username, domain } = splitLocalAndDomain(parsed.bare);
  const resolvedDomain = account.chatDomain?.trim() || domain;
  const resolvedResource = parsed.resource || "openclaw";

  const xmpp = createClient({
    service: account.service,
    domain: resolvedDomain,
    resource: resolvedResource,
    username,
    password: account.password,
    timeout: 30_000,
  });

  let stopped = false;
  let settled = false;

  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {
    // Prevent unhandled-rejection noise before callers attach their own handlers.
  });

  const updateStatus = (extra: Record<string, unknown>) => {
    setStatus?.({
      accountId: account.accountId,
      jid: parsed.bare,
      service: account.service,
      transportImplemented: true,
      transportState: xmpp.status ?? "starting",
      ...extra,
    });
  };

  const settleResolve = () => {
    if (settled) return;
    settled = true;
    resolveDone();
  };

  const settleReject = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectDone(error);
  };

  xmpp.on("status", (status: string) => {
    log?.info?.(`[${account.accountId}] XMPP status -> ${status}`);
    updateStatus({ transportState: status });
  });

  xmpp.on("online", async (address: { toString(): string }) => {
    log?.info?.(`[${account.accountId}] XMPP online as ${address.toString()}`);
    updateStatus({
      connectedJid: address.toString(),
      transportState: "online",
    });

    try {
      await xmpp.send(xml("presence", {}, buildCapsElement()));
    } catch (error) {
      log?.warn?.(
        `[${account.accountId}] failed to send initial presence: ${String(error)}`
      );
    }
  });

  xmpp.on("offline", () => {
    log?.info?.(`[${account.accountId}] XMPP offline`);
    updateStatus({ transportState: "offline" });
    if (stopped) {
      settleResolve();
    }
  });

  xmpp.on("error", (error: unknown) => {
    const message = String(error);
    log?.error?.(`[${account.accountId}] XMPP transport error: ${message}`);
    updateStatus({
      transportError: message,
    });
  });

  xmpp.on("stanza", (stanza: { is?: (name: string) => boolean; attrs?: Record<string, unknown>; getChildText?: (name: string) => string | undefined }) => {
    if (stanza?.is?.("message") || stanza?.is?.("presence")) {
      log?.debug?.(`[${account.accountId}] received stanza ${summarizeStanza(stanza)}`);
    }
  });

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    updateStatus({ transportState: "stopping" });
    try {
      await xmpp.stop();
      settleResolve();
    } catch (error) {
      const message = String(error);
      log?.warn?.(`[${account.accountId}] XMPP transport stop error: ${message}`);
      updateStatus({
        transportState: "stop-error",
        transportStopError: message,
      });
      settleReject(error);
      throw error;
    }
  };

  const onAbort = () => {
    void stop().catch((error) => {
      log?.error?.(`[${account.accountId}] XMPP stop failed: ${String(error)}`);
    });
  };

  abortSignal?.addEventListener?.("abort", onAbort, { once: true });

  try {
    updateStatus({
      domain: resolvedDomain,
      resource: resolvedResource,
      transportState: "connecting",
    });
    await xmpp.start();
  } catch (error) {
    abortSignal?.removeEventListener?.("abort", onAbort);

    try {
      await xmpp.stop();
    } catch {
      // Ignore cleanup errors after a failed start attempt.
    }

    settleReject(error);
    throw error;
  }

  done.then(
    () => {
      abortSignal?.removeEventListener?.("abort", onAbort);
    },
    () => {
      abortSignal?.removeEventListener?.("abort", onAbort);
    }
  );

  return { client: xmpp, done, stop };
}
