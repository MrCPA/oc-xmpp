import test from "node:test";
import assert from "node:assert/strict";

import { xml } from "@xmpp/client";

import {
  NS_OMEMO,
  OMEMO_BUNDLES_NODE,
  OMEMO_DEVICELIST_NODE,
  buildOmemoBundleItem,
  buildOmemoDeviceListItem,
  extractDeviceList,
  parseBundle,
} from "../src/omemo.ts";

test("modern OMEMO constants target omemo:2 nodes", () => {
  assert.equal(NS_OMEMO, "urn:xmpp:omemo:2");
  assert.equal(OMEMO_DEVICELIST_NODE, "urn:xmpp:omemo:2:devices");
  assert.equal(OMEMO_BUNDLES_NODE, "urn:xmpp:omemo:2:bundles");
});

test("buildOmemoDeviceListItem emits omemo:2 devices payload", () => {
  const item = buildOmemoDeviceListItem([42, 7]);
  assert.equal(item.attrs.id, "current");
  const devices = item.getChild("devices", NS_OMEMO);
  assert.ok(devices);
  assert.deepEqual(
    devices.getChildren("device").map((device) => device.attrs.id),
    ["42", "7"]
  );
});

test("extractDeviceList reads omemo:2 devices payload", () => {
  const items = xml(
    "items",
    { node: OMEMO_DEVICELIST_NODE },
    xml(
      "item",
      { id: "current" },
      xml(
        "devices",
        { xmlns: NS_OMEMO },
        xml("device", { id: "9" }),
        xml("device", { id: "3" })
      )
    )
  );

  assert.deepEqual(extractDeviceList(items), [3, 9]);
});

test("buildOmemoBundleItem and parseBundle round-trip modern omemo:2 bundle shape", () => {
  const item = buildOmemoBundleItem(
    31415,
    {
      keyId: 1,
      pubKey: Buffer.from("signed-pub").toString("base64"),
      privKey: Buffer.from("signed-priv").toString("base64"),
      signature: Buffer.from("signature").toString("base64"),
      createdAt: new Date(0).toISOString(),
    },
    [
      {
        keyId: 7,
        pair: {
          pubKey: Buffer.from("prekey-7").toString("base64"),
          privKey: Buffer.from("prekey-7-priv").toString("base64"),
        },
      },
      {
        keyId: 8,
        pair: {
          pubKey: Buffer.from("prekey-8").toString("base64"),
          privKey: Buffer.from("prekey-8-priv").toString("base64"),
        },
      },
    ],
    {
      pubKey: Buffer.from("identity-pub").toString("base64"),
      privKey: Buffer.from("identity-priv").toString("base64"),
    }
  );

  assert.equal(item.attrs.id, "31415");
  const parsed = parseBundle(xml("items", { node: OMEMO_BUNDLES_NODE }, item));
  assert.ok(parsed);
  assert.equal(parsed.signedPreKey.keyId, 1);
  assert.deepEqual(parsed.preKeys.map((entry) => entry.keyId), [7, 8]);
  assert.equal(Buffer.from(parsed.identityKey).toString(), "identity-pub");
});
