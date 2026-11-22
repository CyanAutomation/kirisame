import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  accountId: "c40f3cb30efbf8c6d081cf9e50a61931",
  worker: {
    name: "kirisame",
    entrypoint,
    compatibilityDate: "2026-11-21",
    env: {
      PUBLISHING_ENABLED: bindings.text("false"),
      GITHUB_APP_ID: bindings.text("3345400"),
      GITHUB_APP_CLIENT_ID: bindings.text(""),
      GITHUB_REPOSITORY_ALLOWLIST: bindings.text("[]"),
      GITHUB_APP_PRIVATE_KEY: bindings.secret(),
    },
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 0.2, invocationLogs: true },
      traces: { enabled: true, headSamplingRate: 0.05 },
    },
  },
});
