import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { startXmppTransport } from "../src/client.ts";

class FakeXmppClient extends EventEmitter {
  status = "offline";
  sent: unknown[] = [];
  stopCalls = 0;
  startCalls = 0;
  failStartWith: unknown = null;
  failStopWith: unknown = null;

  async start() {
    this.startCalls += 1;
    this.status = "connecting";
    if (this.failStartWith) {
      throw this.failStartWith;
    }
    this.status = "online";
    this.emit("status", "online");
    this.emit("online", { toString: () => "bot@example.com/openclaw" });
  }

  async stop() {
    this.stopCalls += 1;
    this.status = "offline";
    if (this.failStopWith) {
      throw this.failStopWith;
    }
    this.emit("offline");
  }

  async send(stanza: unknown) {
    this.sent.push(stanza);
  }
}

function createAccount() {
  return {
    accountId: "default",
    jid: "bot@example.com",
    password: "secret",
    service: "xmpp://example.com:5222",
  };
}

test("startXmppTransport starts client, sends presence, and reports online state", async () => {
  const fake = new FakeXmppClient();
  const statuses: Array<Record<string, unknown>> = [];

  const lifecycle = await startXmppTransport({
    account: createAccount(),
    createClient: (() => fake) as never,
    setStatus: (status) => statuses.push(status),
  });

  assert.equal(fake.startCalls, 1);
  assert.equal(fake.sent.length, 1);
  assert.equal(statuses.some((status) => status.transportState === "connecting"), true);
  assert.equal(statuses.some((status) => status.transportState === "online"), true);

  await lifecycle.stop();
  await lifecycle.done;
  assert.equal(fake.stopCalls, 1);
});

test("startXmppTransport abort signal triggers stop exactly once", async () => {
  const fake = new FakeXmppClient();
  const abortController = new AbortController();

  const lifecycle = await startXmppTransport({
    account: createAccount(),
    createClient: (() => fake) as never,
    abortSignal: abortController.signal,
  });

  abortController.abort();
  await lifecycle.done;

  assert.equal(fake.stopCalls, 1);
});

test("startXmppTransport cleans up after failed start", async () => {
  const fake = new FakeXmppClient();
  fake.failStartWith = new Error("connect failed");

  await assert.rejects(
    startXmppTransport({
      account: createAccount(),
      createClient: (() => fake) as never,
    }),
    /connect failed/
  );

  assert.equal(fake.startCalls, 1);
  assert.equal(fake.stopCalls, 1);
});

test("startXmppTransport surfaces stop failures", async () => {
  const fake = new FakeXmppClient();
  fake.failStopWith = new Error("stop failed");
  const statuses: Array<Record<string, unknown>> = [];

  const lifecycle = await startXmppTransport({
    account: createAccount(),
    createClient: (() => fake) as never,
    setStatus: (status) => statuses.push(status),
  });

  await assert.rejects(lifecycle.stop(), /stop failed/);
  await assert.rejects(lifecycle.done, /stop failed/);
  assert.equal(statuses.some((status) => status.transportState === "stop-error"), true);
});
