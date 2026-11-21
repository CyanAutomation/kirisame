import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  accountId: "c40f3cb30efbf8c6d081cf9e50a61931",
  worker: {
    name: "kirisame",
    entrypoint,
    compatibilityDate: "2026-11-21",
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 0.2, invocationLogs: true },
      traces: { enabled: true, headSamplingRate: 0.05 },
    },
  },
});
