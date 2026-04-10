import {
  createPluginRuntimeStore,
  type PluginRuntime,
} from "openclaw/plugin-sdk/runtime-store";

const store = createPluginRuntimeStore<PluginRuntime>(
  "XMPP plugin runtime not initialized"
);

export const setXmppRuntime = store.setRuntime;
export const getXmppRuntime = store.getRuntime;
export const tryGetXmppRuntime = store.tryGetRuntime;
