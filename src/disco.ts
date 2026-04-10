import { createHash } from "node:crypto";

import { xml, type XmppElement } from "@xmpp/client";

import { NS_OMEMO, OMEMO_DEVICELIST_NODE } from "./omemo.js";

export const NS_DISCO_INFO = "http://jabber.org/protocol/disco#info";
export const NS_CAPS = "http://jabber.org/protocol/caps";
export const CAPS_NODE = "https://openclaw.ai/plugins/oc-xmpp";

const IDENTITIES = [{ category: "client", type: "bot", name: "OpenClaw XMPP" }];
const FEATURES = [
  NS_DISCO_INFO,
  NS_OMEMO,
  `${OMEMO_DEVICELIST_NODE}+notify`,
  "urn:xmpp:sce:1",
];

function buildCapsVerificationString(): string {
  const identities = IDENTITIES.map((identity) =>
    [identity.category, identity.type, "", identity.name].join("/")
  ).sort();
  const features = [...FEATURES].sort();
  return [...identities.map((value) => `${value}<`), ...features.map((value) => `${value}<`)].join("");
}

export function getCapsVer(): string {
  return createHash("sha1").update(buildCapsVerificationString(), "utf8").digest("base64");
}

export function getCapsNode(): string {
  return `${CAPS_NODE}#${getCapsVer()}`;
}

export function buildCapsElement(): XmppElement {
  return xml("c", { xmlns: NS_CAPS, hash: "sha-1", node: CAPS_NODE, ver: getCapsVer() });
}

export function supportsDiscoInfoNode(node: string | undefined): boolean {
  return !node || node === getCapsNode();
}

export function buildDiscoInfoResult(node?: string): XmppElement {
  return xml(
    "query",
    { xmlns: NS_DISCO_INFO, ...(node ? { node } : {}) },
    ...IDENTITIES.map((identity) => xml("identity", identity)),
    ...FEATURES.map((feature) => xml("feature", { var: feature }))
  );
}
