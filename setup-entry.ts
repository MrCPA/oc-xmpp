import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { xmppPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(xmppPlugin);
