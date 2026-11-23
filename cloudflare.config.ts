import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import * as canaryHarnessEntrypoint from "./src/canary/harness.ts" with { type: "cf-worker" };
import { CANARY_PUBLISHER_BINDING, resolveCanarySettings } from "./src/publication/canary-settings.js";
import { resolveWorkerSettings } from "./src/publication/worker-settings.js";

const processEnvironment = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;
const canarySettings = resolveCanarySettings(processEnvironment ?? {});

export default defineConfig(({ mode }) => {
  const settings = resolveWorkerSettings(mode, canarySettings, processEnvironment);

  return {
    accountId: "c40f3cb30efbf8c6d081cf9e50a61931",
    worker: {
      name: settings.workerName,
      entrypoint: settings.canaryHarness ? canaryHarnessEntrypoint : entrypoint,
      compatibilityDate: "2026-11-22",
      env: workerEnvironment(settings),
      observability: {
        enabled: true,
        logs: { enabled: true, headSamplingRate: 0.2, invocationLogs: true },
        traces: { enabled: true, headSamplingRate: 0.05 },
      },
    },
  };
});

function workerEnvironment(settings: ReturnType<typeof resolveWorkerSettings>) {
  if (settings.canaryHarness) {
    return {
      KIRISAME_CANARY_ENABLED: bindings.text(settings.canaryEnabled ? "true" : "false"),
      KIRISAME_CANARY_REPOSITORY: bindings.text(settings.canaryRepository),
      KIRISAME_CANARY_BASE_REF: bindings.text(settings.canaryBaseRef),
      KIRISAME: bindings.worker(CANARY_PUBLISHER_BINDING),
    };
  }

  return {
    PUBLISHING_ENABLED: bindings.text(settings.publishingEnabled ? "true" : "false"),
    GITHUB_APP_ID: bindings.text("3345400"),
    GITHUB_APP_CLIENT_ID: bindings.text(""),
    GITHUB_REPOSITORY_ALLOWLIST: bindings.text(settings.repositoryAllowlist),
    GITHUB_APP_PRIVATE_KEY: bindings.secret(),
    KIRISAME_SOURCE_SHA: bindings.text(settings.sourceSha),
    KIRISAME_APP_VERSION: bindings.text(settings.appVersion),
    KIRISAME_CONTRACT_VERSION: bindings.text("1"),
    KIRISAME_BUILD_TIMESTAMP: bindings.text(settings.buildTimestamp),
  };
}
