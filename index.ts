import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { xmppPlugin } from "./src/channel.js";
import { setXmppRuntime } from "./src/runtime.js";

const XMPP_GLOBAL_HOOKS = Symbol.for("oc-xmpp.global-error-hooks");
const globalScope = globalThis as typeof globalThis & { [XMPP_GLOBAL_HOOKS]?: boolean };

if (!globalScope[XMPP_GLOBAL_HOOKS]) {
  globalScope[XMPP_GLOBAL_HOOKS] = true;
  process.on("unhandledRejection", (reason) => {
    console.error("[xmpp] unhandledRejection", reason);
  });
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    console.error("[xmpp] uncaughtExceptionMonitor", origin, error);
  });
}

export default defineChannelPluginEntry({
  id: "xmpp",
  name: "XMPP",
  description: "XMPP channel plugin scaffold for OpenClaw",
  plugin: xmppPlugin,
  setRuntime: setXmppRuntime,
});

export { xmppPlugin, setXmppRuntime };
