import { normalizeXmppBareJid } from "./ids.js";

export const MAX_SEEN_MESSAGE_IDS = 500;
export const ROOM_HISTORY_REPLAY_MAX_AGE_MS = 2 * 60 * 1000;

export function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value): value is string => Boolean(value));
}

export function normalizeXmppJidArray(values: unknown): string[] {
  const normalized = normalizeStringArray(values)
    .map((value) => normalizeXmppBareJid(value))
    .filter((value): value is string => Boolean(value));
  return [...new Set(normalized)];
}

export function validateXmppSetupInput(params: {
  jid?: string;
  password?: string;
  service?: string;
}): string | null {
  const jid = String(params.jid ?? "").trim();
  const password = String(params.password ?? "");
  const service = String(params.service ?? "").trim();

  if (!jid || !password || !service) {
    return "XMPP setup needs userId (JID), token (password), and url (service URL).";
  }

  if (!normalizeXmppBareJid(jid)) {
    return "XMPP setup userId must be a valid bare JID like bot@example.com.";
  }

  return null;
}

export function isXmppSenderAllowed(senderJid: string, allowFrom: string[]): boolean {
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

export function resolveRoomAllowlist(allowed: string[] | undefined): string[] {
  return (allowed ?? [])
    .map((value) => normalizeXmppBareJid(value))
    .filter((value): value is string => Boolean(value));
}

export function isRoomAllowed(params: {
  roomJid: string;
  policy?: string;
  allowed?: string[];
}): boolean {
  if ((params.policy ?? "allowlist") === "all") return true;
  return resolveRoomAllowlist(params.allowed).includes(params.roomJid);
}

export function wasMentioned(text: string, nick: string): boolean {
  const trimmedNick = nick.trim();
  if (!trimmedNick) return false;
  const escaped = trimmedNick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\b|[^a-z0-9_])${escaped}([,:]?\\b|$)`, "i");
  return pattern.test(text);
}

export function shouldHandleRoomMessage(params: {
  roomJid: string;
  roomPolicy?: string;
  allowedRooms?: string[];
  replyPolicy?: string;
  senderRealJid?: string;
  dmAllowFrom: string[];
  text: string;
  botNick: string;
}): { allow: boolean; wasMentioned: boolean } {
  if (
    !isRoomAllowed({
      roomJid: params.roomJid,
      policy: params.roomPolicy,
      allowed: params.allowedRooms,
    })
  ) {
    return { allow: false, wasMentioned: false };
  }

  const mentioned = wasMentioned(params.text, params.botNick);
  const replyPolicy = params.replyPolicy ?? "mention-only";

  if (replyPolicy === "open") {
    return { allow: true, wasMentioned: mentioned };
  }

  if (replyPolicy === "mention-only") {
    return { allow: mentioned, wasMentioned: mentioned };
  }

  if (replyPolicy === "dm-allowlist") {
    return {
      allow: Boolean(
        params.senderRealJid && isXmppSenderAllowed(params.senderRealJid, params.dmAllowFrom)
      ),
      wasMentioned: mentioned,
    };
  }

  return { allow: false, wasMentioned: mentioned };
}

export function shouldIgnoreDelayedRoomMessage(params: {
  isDelayed: boolean;
  timestamp: number;
  now?: number;
  maxAgeMs?: number;
}): boolean {
  if (!params.isDelayed) return false;
  return (params.now ?? Date.now()) - params.timestamp > (params.maxAgeMs ?? ROOM_HISTORY_REPLAY_MAX_AGE_MS);
}

export function createSeenMessageTracker(maxEntries = MAX_SEEN_MESSAGE_IDS) {
  const seen = new Map<string, number>();

  return {
    mark(key: string): boolean {
      if (seen.has(key)) return false;
      seen.set(key, Date.now());
      while (seen.size > maxEntries) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
      return true;
    },
    size(): number {
      return seen.size;
    },
  };
}
