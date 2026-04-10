import test from "node:test";
import assert from "node:assert/strict";

import {
  createSeenMessageTracker,
  isXmppSenderAllowed,
  normalizeXmppJidArray,
  shouldHandleRoomMessage,
  shouldIgnoreDelayedRoomMessage,
  validateXmppSetupInput,
} from "../src/policy.ts";

test("validateXmppSetupInput rejects missing fields and malformed JIDs", () => {
  assert.equal(
    validateXmppSetupInput({ jid: "", password: "pw", service: "xmpp://example.com" }),
    "XMPP setup needs userId (JID), token (password), and url (service URL)."
  );

  assert.equal(
    validateXmppSetupInput({ jid: "not-a-jid", password: "pw", service: "xmpp://example.com" }),
    "XMPP setup userId must be a valid bare JID like bot@example.com."
  );

  assert.equal(
    validateXmppSetupInput({ jid: "bot@example.com", password: "pw", service: "xmpp://example.com" }),
    null
  );
});

test("normalizeXmppJidArray trims, normalizes, drops invalid entries, and deduplicates", () => {
  assert.deepEqual(normalizeXmppJidArray([
    " Alice@Example.com ",
    "alice@example.com/resource",
    "",
    null,
    "not-a-jid",
    "bob@example.com",
  ]), ["alice@example.com", "bob@example.com"]);
});

test("isXmppSenderAllowed matches normalized bare JIDs and wildcard entries", () => {
  assert.equal(isXmppSenderAllowed("alice@example.com/Phone", ["alice@example.com"]), true);
  assert.equal(isXmppSenderAllowed("alice@example.com/Phone", ["*"]), true);
  assert.equal(isXmppSenderAllowed("alice@example.com/Phone", ["bob@example.com"]), false);
});

test("shouldHandleRoomMessage respects mention-only, open, and dm-allowlist policies", () => {
  assert.deepEqual(
    shouldHandleRoomMessage({
      roomJid: "room@conference.example.com",
      roomPolicy: "allowlist",
      allowedRooms: ["room@conference.example.com"],
      replyPolicy: "mention-only",
      senderRealJid: "alice@example.com",
      dmAllowFrom: [],
      text: "hey marks-agent, check this",
      botNick: "marks-agent",
    }),
    { allow: true, wasMentioned: true }
  );

  assert.deepEqual(
    shouldHandleRoomMessage({
      roomJid: "room@conference.example.com",
      roomPolicy: "allowlist",
      allowedRooms: ["room@conference.example.com"],
      replyPolicy: "mention-only",
      senderRealJid: "alice@example.com",
      dmAllowFrom: [],
      text: "just chatting",
      botNick: "marks-agent",
    }),
    { allow: false, wasMentioned: false }
  );

  assert.deepEqual(
    shouldHandleRoomMessage({
      roomJid: "room@conference.example.com",
      roomPolicy: "allowlist",
      allowedRooms: ["room@conference.example.com"],
      replyPolicy: "dm-allowlist",
      senderRealJid: "alice@example.com/resource",
      dmAllowFrom: ["alice@example.com"],
      text: "no mention needed here",
      botNick: "marks-agent",
    }),
    { allow: true, wasMentioned: false }
  );

  assert.deepEqual(
    shouldHandleRoomMessage({
      roomJid: "other@conference.example.com",
      roomPolicy: "allowlist",
      allowedRooms: ["room@conference.example.com"],
      replyPolicy: "open",
      senderRealJid: "alice@example.com",
      dmAllowFrom: ["alice@example.com"],
      text: "marks-agent",
      botNick: "marks-agent",
    }),
    { allow: false, wasMentioned: false }
  );
});

test("shouldIgnoreDelayedRoomMessage only drops sufficiently old delayed messages", () => {
  const now = Date.parse("2026-04-10T18:42:00Z");
  assert.equal(
    shouldIgnoreDelayedRoomMessage({
      isDelayed: true,
      timestamp: now - 5 * 60 * 1000,
      now,
      maxAgeMs: 2 * 60 * 1000,
    }),
    true
  );
  assert.equal(
    shouldIgnoreDelayedRoomMessage({
      isDelayed: true,
      timestamp: now - 30 * 1000,
      now,
      maxAgeMs: 2 * 60 * 1000,
    }),
    false
  );
  assert.equal(
    shouldIgnoreDelayedRoomMessage({
      isDelayed: false,
      timestamp: now - 60 * 60 * 1000,
      now,
    }),
    false
  );
});

test("createSeenMessageTracker suppresses duplicates and evicts old entries", () => {
  const tracker = createSeenMessageTracker(2);

  assert.equal(tracker.mark("a"), true);
  assert.equal(tracker.mark("a"), false);
  assert.equal(tracker.mark("b"), true);
  assert.equal(tracker.size(), 2);
  assert.equal(tracker.mark("c"), true);
  assert.equal(tracker.size(), 2);
  assert.equal(tracker.mark("a"), true);
});
