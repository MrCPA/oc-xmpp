import { parseXmppJid } from "./ids.js";
import { shouldIgnoreDelayedRoomMessage } from "./policy.js";

export function resolveMucNickFromJid(jid: string): string {
  const parsed = parseXmppJid(jid);
  const bare = parsed?.bare ?? jid;
  const at = bare.indexOf("@");
  if (at > 0) return bare.slice(0, at);
  return "openclaw";
}

export function senderDisplayName(fromBare: string, resource?: string): string {
  return resource?.trim() || fromBare;
}

export function resolveXmppMessageId(params: {
  stanzaId?: string;
  fallbackSeed: string;
  now?: number;
}): string {
  const raw = params.stanzaId?.trim();
  if (raw) return raw;
  return `xmpp-${params.fallbackSeed}-${params.now ?? Date.now()}`;
}

export function createXmppMessageKey(params: {
  fromBare?: string;
  rawFrom?: string;
  stanzaId?: string;
  fallbackSeed?: string;
  now?: number;
}): string {
  const seed = params.fromBare ?? params.rawFrom ?? params.fallbackSeed ?? "unknown";
  return `${seed}#${resolveXmppMessageId({
    stanzaId: params.stanzaId,
    fallbackSeed: seed,
    now: params.now,
  })}`;
}

export function extractTimestampFromDelayStamp(delayStamp?: string, now = Date.now()): number {
  if (delayStamp) {
    const parsed = Date.parse(delayStamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now;
}

export function resolveDirectMessageBody(params: {
  encryptedHandled: boolean;
  encryptedBody?: string | null;
  plaintextBody?: string | null;
}): string {
  const candidate = params.encryptedHandled ? params.encryptedBody : params.plaintextBody;
  return candidate?.trim() ?? "";
}

export function shouldIgnoreDirectMessage(params: {
  fromBare?: string | null;
  botBareJid: string;
}): boolean {
  return !params.fromBare || params.fromBare === params.botBareJid;
}

export function shouldIgnoreRoomMessage(params: {
  fromBare?: string | null;
  fromResource?: string | null;
  botNick: string;
  body: string;
  isDelayed: boolean;
  timestamp: number;
  now?: number;
  maxAgeMs?: number;
}): { ignore: boolean; reason?: string } {
  if (!params.fromBare) {
    return { ignore: true, reason: "missing-room-jid" };
  }

  if (!params.body.trim()) {
    return { ignore: true, reason: "empty-body" };
  }

  if ((params.fromResource ?? "").trim() === params.botNick) {
    return { ignore: true, reason: "self-message" };
  }

  if (
    shouldIgnoreDelayedRoomMessage({
      isDelayed: params.isDelayed,
      timestamp: params.timestamp,
      now: params.now,
      maxAgeMs: params.maxAgeMs,
    })
  ) {
    return { ignore: true, reason: "delayed-history" };
  }

  return { ignore: false };
}
