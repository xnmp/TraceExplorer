import { tracePlugin } from "./lib/plugins/trace";
import { openAIImagePlugin } from "./lib/plugins/openai-image";
import { configureBackend } from "./lib/api/common";
import { host } from "./sdk";
import type { Plugin } from "../integration/plugin-sdk";

host();
export const plugins: Plugin[] = [tracePlugin, openAIImagePlugin].map((plugin) => ({
  ...plugin,
  activate(ctx) {
    if (!ctx.backend) throw new Error("TraceExplorer native backend is unavailable");
    configureBackend(ctx.backend);
    return plugin.activate(ctx);
  },
}));
