# OMEMO Audit

Status: in progress
Date: 2026-04-10

## High-confidence findings

### 1. The plugin was implementing legacy OMEMO 0.3, not OMEMO:2

Legacy code used:
- namespace: `eu.siacs.conversations.axolotl`
- device node: `eu.siacs.conversations.axolotl.devicelist`
- bundle node pattern: `eu.siacs.conversations.axolotl.bundles:<deviceId>`
- legacy payload names like `<list>`, `<signedPreKeyPublic>`, `<signedPreKeySignature>`, `<identityKey>`, `<preKeyPublic>`

Modern XEP-0384 uses:
- namespace: `urn:xmpp:omemo:2`
- device node: `urn:xmpp:omemo:2:devices`
- bundle node: `urn:xmpp:omemo:2:bundles`
- item ids keyed by device id for bundles
- payload names like `<devices>`, `<spk>`, `<spks>`, `<ik>`, `<pk>`

This mismatch alone is enough to explain clients reporting that the contact does not support OMEMO.

### 2. The publish path was missing required interoperability details

The old code did not publish with modern publish options. XEP-0384 requires open access for devices and bundles, and bundles are expected on the shared bundles node with per-device item ids.

### 3. Message encryption is still not fully migrated

The codebase still appears to use a legacy header/payload shape:
- flat `<key>` elements directly under `<header>`
- explicit `<iv>` in the header
- payload built from ciphertext only, not an OMEMO:2 SCE envelope

Modern OMEMO:2 message structure uses:
- `<keys jid='...'>` groups in the header
- `kex='true'` for key exchange markers
- a modern payload/envelope structure described by XEP-0384

This means discovery/publication and transport are separate migration surfaces. Discovery can be fixed first, but a full standards migration also requires transport changes.

### 4. Bundle processing used a suspicious `registrationId` mapping

The code was passing `registrationId: deviceId` into the Signal prekey device object. Those are not the same concept, and this could corrupt session setup behavior.

## Changes started

- switched constants to OMEMO:2 namespace and node names
- added modern device/bundle builders for OMEMO:2 payload shapes
- added modern parse support for OMEMO:2 payloads while keeping legacy read compatibility where practical
- added publish-options support so nodes can be published with explicit access settings
- started moving bundle fetches to the shared OMEMO:2 bundles node
- added focused tests for modern device-list and bundle wire shapes

## Remaining work

1. Finish the shared-bundles fetch/publish migration end-to-end.
2. Migrate message transport from the legacy flat-header format to OMEMO:2 header semantics.
3. Confirm the payload/envelope matches the XEP-0384 SCE profile.
4. Add tests for modern encrypted message encode/decode structure.
5. Revalidate against the live Prosody host and a real client round-trip.

## Recommendation

Treat this as a staged migration:
1. discovery/publication correctness
2. message envelope correctness
3. live round-trip validation

Do not assume “server stores data” means OMEMO works. Client-visible interoperability depends on exact wire compatibility.
