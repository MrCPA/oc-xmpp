# VPN Host XMPP Rollout Checklist

Use this when reintroducing `oc-xmpp` on the VPN host.

Target host used during earlier recovery work:
- `root@172.234.238.175`

This checklist is designed to keep the gateway recoverable at every step.

## Safety rules

- Do not combine this with unrelated OpenClaw changes.
- Roll out only from a known tested commit.
- Keep a working backup of `openclaw.json` before enabling XMPP.
- Start with `omemo.mode: "off"`.
- Use a non-production or tightly scoped XMPP account first if available.

## Preconditions

- `oc-xmpp` repo is up to date locally
- local tests pass
- canary checklist in `docs/CANARY.md` is understood
- host gateway is healthy without XMPP enabled

## Recommended first rollout config

Use the smallest useful blast radius:

- `dm.policy: "allowlist"`
- `dm.allowFrom`: only your own test JID
- `groups.policy: "allowlist"`
- `groups.allowed`: one dedicated test room only
- `groups.replyPolicy: "mention-only"`
- `omemo.mode: "off"`

## Phase 0: verify local state

From local repo:

```bash
cd /workspace/oc-xmpp
npm run build
npm test
```

## Phase 1: sync plugin to host without enabling it yet

```bash
ssh -i /workspace/.ssh/id_rsa root@172.234.238.175 'mkdir -p /root/.openclaw/workspace/oc-xmpp'
tar -C /workspace/oc-xmpp --exclude=node_modules --exclude=dist --exclude=.git -cf - . \
  | ssh -i /workspace/.ssh/id_rsa root@172.234.238.175 'tar -C /root/.openclaw/workspace/oc-xmpp -xf -'
ssh -i /workspace/.ssh/id_rsa root@172.234.238.175 'cd /root/.openclaw/workspace/oc-xmpp && npm install && npm run build'
```

Expected:
- remote build succeeds
- gateway is still untouched

## Phase 2: back up host config

```bash
ssh -i /workspace/.ssh/id_rsa root@172.234.238.175 '
cp /root/.openclaw/openclaw.json /root/.openclaw/openclaw.json.bak.$(date +%Y%m%d-%H%M%S)
'
```

## Phase 3: enable plugin with narrow scope

Update `/root/.openclaw/openclaw.json` carefully:

- ensure plugin path is present in `plugins.load.paths`
- ensure `plugins.allow` includes `xmpp`
- ensure `plugins.entries.xmpp.enabled` is `true`
- add `channels.xmpp` with the narrow canary config

Do not widen DM or room access yet.

## Phase 4: restart and watch logs

```bash
ssh -i /workspace/.ssh/id_rsa root@172.234.238.175 'systemctl --user restart openclaw-gateway.service'
ssh -i /workspace/.ssh/id_rsa root@172.234.238.175 'journalctl --user -u openclaw-gateway.service -n 200 -f'
```

Healthy signs:
- `XMPP provider started`
- `XMPP status -> online`
- `joined XMPP room ...`
- no crash loop

## Phase 5: run manual canary

Use `docs/CANARY.md`.

Minimum pass bar before widening scope:
- DM from allowed JID works once
- DM from non-allowed JID does not leak replies
- room mention in allowed room works once
- non-mention in allowed room does not trigger reply
- reconnect does not cause obvious backlog replies
- gateway stays stable

## Phase 6: only then widen scope

Possible widening order:
1. keep DM allowlist, widen room testing
2. keep room allowlist, widen DM testing
3. test `omemo.mode: "optional"`
4. test `omemo.mode: "required"` only after optional is calm

## Rollback

If the gateway becomes unstable:

1. disable XMPP config/plugin entries
2. restart gateway
3. verify gateway health before further debugging

Example rollback directions:
- remove `channels.xmpp`
- remove `plugins.entries.xmpp`
- remove `xmpp` from `plugins.allow`
- remove `oc-xmpp` from `plugins.load.paths`

## Publish confidence bar

I would feel much better publishing after:
- local tests pass
- remote build passes
- VPN host canary passes with `omemo.mode: "off"`
- reconnect is calm
- optional OMEMO is manually sanity-checked without destabilizing the gateway
