# @openclaw/xmpp

Scaffold for an OpenClaw XMPP channel plugin.

Current status: package skeleton, OpenClaw channel wiring, XMPP conversation/target grammar, transport/login lifecycle, first-pass inbound handling, outbound text delivery, pairing approval notification, and direct-message OMEMO now exist. The plugin normalizes bare JIDs, understands explicit `dm:` and `room:` targets, connects/login with `@xmpp/client`, auto-joins configured rooms, routes direct messages through OpenClaw DM policy/pairing checks, routes groupchat messages with room allowlist and reply-policy gating, sends text replies back for inbound conversations, and can deliver outbound text to direct JIDs or rooms. Media is still basic: outbound media currently degrades to a plain text message with the media URL instead of native XMPP upload. Presence filtering is still basic, and live testing against `talk.ruzicka.us` is still TODO.

## OMEMO status

The plugin now has feature-gated, direct-message-only OMEMO with a GPL-licensed Signal protocol dependency:

- `channels.xmpp.omemo.mode`: `off`, `optional`, or `required`
- `channels.xmpp.omemo.allowUnencryptedFallback`: allow plaintext sends when OMEMO cannot be used
- `channels.xmpp.omemo.replyOnUnsupportedInbound`: optionally send a plaintext explanation when encrypted or rejected plaintext DMs arrive
- `channels.xmpp.omemo.statePath`: override the OMEMO state file path (default: `.openclaw/xmpp/omemo/default.json` relative to the workspace)

What it currently does:

- generates and persists an OMEMO identity key, signed prekey, one-time prekeys, sessions, and seen device identities
- publishes this client’s OMEMO device list and bundle over XMPP PEP/pubsub
- looks up recipient OMEMO device lists and bundles before direct outbound sends
- establishes Signal sessions per recipient device and encrypts direct-message OMEMO payloads
- decrypts inbound OMEMO direct messages addressed to this device
- replenishes prekeys and republishes the bundle after inbound prekey session setup
- enforces `optional` or `required` plaintext policy for direct messages
- preserves existing plain XMPP behavior when `omemo.mode` is `off`
- OMEMO is now lazy-loaded only when `omemo.mode` is not `off`, which makes plain XMPP deployments safer and avoids loading the Signal/OMEMO stack when it is not being used

Current limits:

- scope is still direct-message-only, not MUC/channel OMEMO
- trust handling is still pragmatic first-seen storage, not a polished verification UX
- at-rest key protection is currently filesystem JSON state, not hardware-backed secret storage
- interop still needs real-world validation against multiple OMEMO clients and edge cases

Because this now depends on `@privacyresearch/libsignal-protocol-typescript` (`GPL-3.0-only`), this package is licensed `GPL-3.0-only` as well.

Next steps:

1. Interop test against real OMEMO clients on Prosody.
2. Tighten trust/fingerprint policy and operator visibility.
3. Improve device-change handling and stale-session recovery.
4. Tighten mention/presence filtering and MUC edge cases.
5. Add native media upload support if we want real attachments.
