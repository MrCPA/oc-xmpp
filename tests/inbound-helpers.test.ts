import test from "node:test";
import assert from "node:assert/strict";

import {
  createXmppMessageKey,
  extractTimestampFromDelayStamp,
  resolveDirectMessageBody,
  resolveMucNickFromJid,
  resolveXmppMessageId,
  senderDisplayName,
  shouldIgnoreDirectMessage,
  shouldIgnoreRoomMessage,
} from "../src/inbound-helpers.ts";

test("resolveMucNickFromJid derives nick from bare JID localpart", () => {
  assert.equal(resolveMucNickFromJid("Bot@Example.com/desktop"), "bot");
  assert.equal(resolveMucNickFromJid("not-a-jid"), "openclaw");
});

test("senderDisplayName prefers resource over bare JID", () => {
  assert.equal(senderDisplayName("alice@example.com", "Phone"), "Phone");
  assert.equal(senderDisplayName("alice@example.com", "   "), "alice@example.com");
});

test("resolveXmppMessageId and createXmppMessageKey prefer stanza ids when present", () => {
  assert.equal(
    resolveXmppMessageId({ stanzaId: " msg-1 ", fallbackSeed: "alice@example.com", now: 123 }),
    "msg-1"
  );
  assert.equal(
    resolveXmppMessageId({ fallbackSeed: "alice@example.com", now: 123 }),
    "xmpp-alice@example.com-123"
  );
  assert.equal(
    createXmppMessageKey({
      fromBare: "alice@example.com",
      stanzaId: "msg-1",
      now: 123,
    }),
    "alice@example.com#msg-1"
  );
});

test("extractTimestampFromDelayStamp parses valid stamps and falls back on invalid ones", () => {
  const now = 123456789;
  assert.equal(
    extractTimestampFromDelayStamp("2026-04-10T18:52:00Z", now),
    Date.parse("2026-04-10T18:52:00Z")
  );
  assert.equal(extractTimestampFromDelayStamp("not-a-date", now), now);
  assert.equal(extractTimestampFromDelayStamp(undefined, now), now);
});

test("resolveDirectMessageBody chooses encrypted or plaintext body and trims it", () => {
  assert.equal(
    resolveDirectMessageBody({
      encryptedHandled: true,
      encryptedBody: "  secret hello  ",
      plaintextBody: "ignored",
    }),
    "secret hello"
  );
  assert.equal(
    resolveDirectMessageBody({
      encryptedHandled: false,
      encryptedBody: "ignored",
      plaintextBody: "  plain hello  ",
    }),
    "plain hello"
  );
  assert.equal(
    resolveDirectMessageBody({
      encryptedHandled: true,
      encryptedBody: "   ",
      plaintextBody: "ignored",
    }),
    ""
  );
});

test("shouldIgnoreDirectMessage ignores missing or self-sent DMs", () => {
  assert.equal(
    shouldIgnoreDirectMessage({ fromBare: undefined, botBareJid: "bot@example.com" }),
    true
  );
  assert.equal(
    shouldIgnoreDirectMessage({ fromBare: "bot@example.com", botBareJid: "bot@example.com" }),
    true
  );
  assert.equal(
    shouldIgnoreDirectMessage({ fromBare: "alice@example.com", botBareJid: "bot@example.com" }),
    false
  );
});

test("shouldIgnoreRoomMessage filters missing room, self-message, empty body, and delayed history", () => {
  assert.deepEqual(
    shouldIgnoreRoomMessage({
      fromBare: undefined,
      fromResource: "Alice",
      botNick: "bot",
      body: "hello",
      isDelayed: false,
      timestamp: 0,
    }),
    { ignore: true, reason: "missing-room-jid" }
  );

  assert.deepEqual(
    shouldIgnoreRoomMessage({
      fromBare: "room@conference.example.com",
      fromResource: "bot",
      botNick: "bot",
      body: "hello",
      isDelayed: false,
      timestamp: 0,
    }),
    { ignore: true, reason: "self-message" }
  );

  assert.deepEqual(
    shouldIgnoreRoomMessage({
      fromBare: "room@conference.example.com",
      fromResource: "Alice",
      botNick: "bot",
      body: "   ",
      isDelayed: false,
      timestamp: 0,
    }),
    { ignore: true, reason: "empty-body" }
  );

  assert.deepEqual(
    shouldIgnoreRoomMessage({
      fromBare: "room@conference.example.com",
      fromResource: "Alice",
      botNick: "bot",
      body: "hello",
      isDelayed: true,
      timestamp: Date.parse("2026-04-10T18:40:00Z"),
      now: Date.parse("2026-04-10T18:52:00Z"),
      maxAgeMs: 2 * 60 * 1000,
    }),
    { ignore: true, reason: "delayed-history" }
  );

  assert.deepEqual(
    shouldIgnoreRoomMessage({
      fromBare: "room@conference.example.com",
      fromResource: "Alice",
      botNick: "bot",
      body: "hello",
      isDelayed: false,
      timestamp: 0,
    }),
    { ignore: false }
  );
});
