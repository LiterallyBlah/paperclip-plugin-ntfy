import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { INSTANCE_CONFIG_SCHEMA } from "./config.js";

export const PLUGIN_ID = "paperclip.ntfy-notifier";
export const PLUGIN_VERSION = "0.3.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "ntfy Decision Notifier",
  description:
    "Sends a minimal ntfy push (title \"Paperclip decision <issue>\", tag \"paperclip\", body \"A decision is waiting: <issue>\" plus a link) when a new approval is created or an issue becomes blocked on a human-owned unblock step. Person-addressed questions and board decisions notify only on hosts that emit those events.",
  author: "LiterallyBlah",
  categories: ["connector", "automation"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issue.interactions.read",
    "companies.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: INSTANCE_CONFIG_SCHEMA as unknown as PaperclipPluginManifestV1["instanceConfigSchema"],
};

export default manifest;
