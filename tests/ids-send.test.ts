import test from "node:test";
import assert from "node:assert/strict";

import {
  looksLikeXmppRoomJid,
  normalizeXmppConversationId,
  parseXmppJid,
  parseXmppTarget,
} from "../src/ids.ts";
import { resolveXmppDeliveryTarget } from "../src/send.ts";

test("parseXmppJid normalizes bare JIDs and preserves resource", () => {
  assert.deepEqual(parseXmppJid("Alice@Example.com/Phone"), {
    bare: "alice@example.com",
    resource: "Phone",
  });
  assert.equal(parseXmppJid("not-a-jid"), null);
});

test("parseXmppTarget handles dm, room, and xmpp join targets", () => {
  assert.deepEqual(parseXmppTarget("dm:Alice@Example.com/Phone"), {
    to: "alice@example.com",
    chatType: "direct",
  });

  assert.deepEqual(parseXmppTarget("room:room@conference.example.com"), {
    to: "room@conference.example.com",
    chatType: "channel",
  });

  assert.deepEqual(parseXmppTarget("xmpp:room@conference.example.com?join"), {
    to: "room@conference.example.com",
    chatType: "channel",
  });
});

test("resolveXmppDeliveryTarget infers channel vs direct correctly", () => {
  assert.deepEqual(resolveXmppDeliveryTarget("room@conference.example.com"), {
    to: "room@conference.example.com",
    chatType: "channel",
  });

  assert.deepEqual(resolveXmppDeliveryTarget("bob@example.com/Tablet"), {
    to: "bob@example.com",
    chatType: "direct",
  });

  assert.equal(looksLikeXmppRoomJid("room@conference.example.com"), true);
  assert.equal(normalizeXmppConversationId("xmpp:bob@example.com?message"), "bob@example.com");
});
