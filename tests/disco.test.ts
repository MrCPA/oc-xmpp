import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapsElement,
  buildDiscoInfoResult,
  CAPS_NODE,
  NS_CAPS,
  NS_DISCO_INFO,
  supportsDiscoInfoNode,
} from "../src/disco.ts";

test("buildCapsElement advertises stable XMPP caps", () => {
  const caps = buildCapsElement();
  assert.equal(caps.name, "c");
  assert.equal(caps.attrs.xmlns, NS_CAPS);
  assert.equal(caps.attrs.hash, "sha-1");
  assert.equal(caps.attrs.node, CAPS_NODE);
  assert.ok(typeof caps.attrs.ver === "string" && caps.attrs.ver.length > 10);
});

test("buildDiscoInfoResult advertises OMEMO and SCE support", () => {
  const query = buildDiscoInfoResult();
  assert.equal(query.name, "query");
  assert.equal(query.attrs.xmlns, NS_DISCO_INFO);
  const features = query.getChildren("feature").map((child) => child.attrs.var);
  assert.ok(features.includes("urn:xmpp:omemo:2"));
  assert.ok(features.includes("urn:xmpp:omemo:2:devices+notify"));
  assert.ok(features.includes("urn:xmpp:sce:1"));
});

test("supportsDiscoInfoNode accepts empty or matching caps nodes only", () => {
  assert.equal(supportsDiscoInfoNode(undefined), true);
  const matchingNode = `${CAPS_NODE}#${buildCapsElement().attrs.ver}`;
  assert.equal(supportsDiscoInfoNode(matchingNode), true);
  assert.equal(supportsDiscoInfoNode(`${CAPS_NODE}#wrong`), false);
});
