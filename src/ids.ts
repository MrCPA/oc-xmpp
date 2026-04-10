export interface ParsedXmppJid {
  bare: string;
  resource?: string;
}

export interface ParsedXmppTarget {
  to: string;
  chatType?: "direct" | "channel";
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  if (index < 0) return [value, undefined];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

export function parseXmppJid(raw: string): ParsedXmppJid | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const [bareRaw, resourceRaw] = splitOnce(trimmed, "/");
  const bare = bareRaw.trim().toLowerCase();
  if (!bare || !bare.includes("@")) return null;

  const resource = resourceRaw?.trim() || undefined;
  return { bare, resource };
}

export function normalizeXmppBareJid(raw: string): string | undefined {
  return parseXmppJid(raw)?.bare;
}

export function looksLikeXmppRoomJid(raw: string): boolean {
  const jid = normalizeXmppBareJid(raw);
  if (!jid) return false;
  return jid.includes("@conference.") || jid.includes("@muc.");
}

export function parseXmppTarget(raw: string): ParsedXmppTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let chatType: "direct" | "channel" | undefined;
  let candidate = trimmed;

  if (/^(dm|jid):/i.test(candidate)) {
    chatType = "direct";
    candidate = candidate.replace(/^(dm|jid):/i, "");
  } else if (/^(room|muc):/i.test(candidate)) {
    chatType = "channel";
    candidate = candidate.replace(/^(room|muc):/i, "");
  } else if (/^xmpp:/i.test(candidate)) {
    candidate = candidate.replace(/^xmpp:/i, "");
    const [address, query] = splitOnce(candidate, "?");
    candidate = address;
    if (query?.toLowerCase().startsWith("join")) {
      chatType = "channel";
    }
  }

  const to = normalizeXmppBareJid(candidate);
  if (!to) return null;

  if (!chatType && looksLikeXmppRoomJid(to)) {
    chatType = "channel";
  }

  return { to, chatType };
}

export function normalizeXmppConversationId(raw: string): string | undefined {
  return parseXmppTarget(raw)?.to ?? normalizeXmppBareJid(raw);
}

export function resolveXmppSessionConversation(kind: "group" | "channel", rawId: string) {
  const id = normalizeXmppConversationId(rawId);
  if (!id) return null;

  return {
    id,
    threadId: undefined,
    baseConversationId: id,
    parentConversationCandidates: [id],
  };
}
