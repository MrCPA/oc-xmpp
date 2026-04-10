import { xml, type XmppClient } from "@xmpp/client";

import type { XmppOmemoController } from "./omemo.js";

import {
  looksLikeXmppRoomJid,
  normalizeXmppConversationId,
  parseXmppTarget,
} from "./ids.js";

export interface ResolvedXmppDeliveryTarget {
  to: string;
  chatType: "direct" | "channel";
}

export interface XmppSendResult {
  channel: "xmpp";
  messageId: string;
  conversationId: string;
}

export function resolveXmppDeliveryTarget(raw: string): ResolvedXmppDeliveryTarget {
  const parsed = parseXmppTarget(raw);
  const to = parsed?.to ?? normalizeXmppConversationId(raw);
  if (!to) {
    throw new Error(`Invalid XMPP target: ${raw}`);
  }

  return {
    to,
    chatType: parsed?.chatType ?? (looksLikeXmppRoomJid(to) ? "channel" : "direct"),
  };
}

function createXmppMessageId(): string {
  return `xmpp-${crypto.randomUUID()}`;
}

export async function sendXmppTextMessage(params: {
  client: XmppClient;
  omemo?: XmppOmemoController;
  to: string;
  text: string;
  chatType: "direct" | "channel";
}): Promise<XmppSendResult> {
  const trimmed = params.text.trim();
  const messageId = createXmppMessageId();

  if (trimmed) {
    const encryptedStanza = await params.omemo?.beforeSend({
      to: params.to,
      chatType: params.chatType,
      text: trimmed,
      messageId,
    });

    if (encryptedStanza) {
      await params.client.send(encryptedStanza);
    } else {
      await params.client.send(
        xml(
          "message",
          {
            id: messageId,
            to: params.to,
            type: params.chatType === "channel" ? "groupchat" : "chat",
          },
          xml("body", {}, trimmed)
        )
      );

      await params.omemo?.afterPlaintextSend({
        to: params.to,
        chatType: params.chatType,
        text: trimmed,
      });
    }
  }

  return {
    channel: "xmpp",
    messageId,
    conversationId: params.to,
  };
}
