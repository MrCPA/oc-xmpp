# XMPP Canary Validation Plan

Use this before re-enabling or publishing the plugin in a real deployment.

## Goal

Exercise the highest-risk behaviors with a **non-production XMPP bot account** and, if possible, a dedicated test room.

This plan is designed to catch:
- bad startup / shutdown behavior
- reconnect regressions
- duplicate delivery handling problems
- delayed room backlog replies after reconnect
- DM policy mistakes
- room reply-policy mistakes
- OMEMO off / optional / required surprises

## Preconditions

- OpenClaw host is healthy without XMPP enabled
- test bot JID and password are available
- one human test JID is available
- one test MUC room is available
- `oc-xmpp` checkout is on the commit you intend to validate
- gateway logs are accessible

## Recommended canary config

Start with the safest useful profile:

```json
{
  "channels": {
    "xmpp": {
      "jid": "bot@example.com",
      "password": "REDACTED",
      "service": "xmpp://example.com:5222",
      "dm": {
        "policy": "allowlist",
        "allowFrom": ["human@example.com"]
      },
      "groups": {
        "policy": "allowlist",
        "allowed": ["test-room@conference.example.com"],
        "replyPolicy": "mention-only"
      },
      "omemo": {
        "mode": "off"
      }
    }
  }
}
```

Do **not** start with `groups.policy: "all"` or `dm.policy: "open"`.

## Phase 1: startup and idle health

Expected:
- provider starts
- bot goes online
- room join succeeds
- gateway remains stable for several minutes

Checks:
1. build plugin
2. restart gateway with XMPP enabled
3. watch logs for:
   - `XMPP provider started`
   - `XMPP status -> online`
   - `joined XMPP room ...`
4. confirm no crash loop and no repeated startup/shutdown churn

## Phase 2: direct-message safety

From the allowed test JID:
1. send a plain DM
2. confirm reply arrives once
3. resend the same message quickly if the client can do so
4. confirm no obvious duplicate reply behavior

From a non-allowed JID:
1. send a DM
2. confirm no unauthorized reply leaks through

If using pairing mode later:
1. switch `dm.policy` to `pairing`
2. verify challenge path
3. approve pairing
4. verify subsequent DM works

## Phase 3: room policy safety

In the allowed test room:
1. send a normal message without mentioning the bot
2. under `mention-only`, confirm no reply
3. mention the bot nickname
4. confirm exactly one reply

In a room **not** on the allowlist:
1. send a mention
2. confirm no reply

## Phase 4: reconnect behavior

Goal: make sure reconnect does not cause old backlog replies or duplicate responses.

Suggested method:
1. send a few room messages while plugin is online
2. restart the gateway or bounce network connectivity briefly
3. while it is down, add a few messages in the room
4. after reconnect, confirm:
   - bot comes back online
   - old delayed room backlog is **not** answered
   - new mention after reconnect is answered normally

## Phase 5: OMEMO progression

Only do this after plaintext mode is stable.

### OMEMO off
- verify plain DM still works

### OMEMO optional
- verify plain DM still works if peer does not support OMEMO
- if peer supports OMEMO, verify encrypted DM can be handled
- confirm failures do not crash provider

### OMEMO required
- verify unsupported plaintext is rejected cleanly
- verify supported encrypted DM still works
- confirm failures stay isolated to the conversation and do not destabilize gateway

## Log patterns to watch for

Healthy signs:
- `XMPP provider started`
- `XMPP status -> online`
- `joined XMPP room ...`
- no repeated fatal transport errors

Concerning signs:
- rapid start/stop loops
- repeated transport errors after a single inbound message
- replies to old delayed room history
- duplicate replies to one inbound message
- shutdown failures or hanging stop behavior
- OMEMO init failure when `mode: "off"`

## Publish gate

I would treat the plugin as much safer to publish if all of these pass:
- startup stable
- DM allowlist behavior correct
- room allowlist + mention gating correct
- reconnect does not trigger backlog replies
- no duplicate replies observed
- OMEMO off is stable
- optional / required OMEMO behavior is at least manually sanity-checked

## Nice next step

When a container runtime becomes available, convert this plan into a disposable-server integration suite so the reconnect/backlog tests are runnable in CI too.
