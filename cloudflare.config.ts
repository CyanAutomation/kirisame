import { bindings, defineConfig, exports as cfExports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import * as canaryHarnessEntrypoint from "./src/canary/harness.ts" with { type: "cf-worker" };
import * as liveCanaryEntrypoint from "./src/canary/live-workflow.ts" with { type: "cf-worker" };
import { CANARY_PUBLISHER_BINDING, LIVE_CANARY_PUBLISHER_BINDING, LIVE_CANARY_WORKER_EXPOSURE, LIVE_CANARY_WORKFLOW, resolveCanarySettings } from "./src/publication/canary-settings.js";
import { resolveWorkerSettings } from "./src/publication/worker-settings.js";

const processEnvironment = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;
const canarySettings = resolveCanarySettings(processEnvironment ?? {});

export default defineConfig(({ mode }) => {
  const settings = resolveWorkerSettings(mode, canarySettings, processEnvironment);

  return {
    accountId: "c40f3cb30efbf8c6d081cf9e50a61931",
    worker: {
      name: settings.workerName,
      entrypoint: settings.workflowInvoker ? liveCanaryEntrypoint
        : settings.canaryHarness ? canaryHarnessEntrypoint : entrypoint,
      compatibilityDate: "2026-11-22",
      env: workerEnvironment(settings),
      ...(settings.workflowInvoker ? {
        ...LIVE_CANARY_WORKER_EXPOSURE,
        exports: {
          [LIVE_CANARY_WORKFLOW.exportName]: cfExports.workflow({
            name: LIVE_CANARY_WORKFLOW.name,
            limits: { steps: LIVE_CANARY_WORKFLOW.maxSteps },
            concurrency: { limit: LIVE_CANARY_WORKFLOW.concurrencyLimit },
            defaultRetention: {
              successRetention: LIVE_CANARY_WORKFLOW.retention,
              errorRetention: LIVE_CANARY_WORKFLOW.retention,
            },
          }),
        },
      } : {}),
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
      KIRISAME_CALLER_ID: bindings.text(settings.callerId ?? "kirisame-canary-harness"),
      KIRISAME_API_KEY: bindings.secret(),
      KIRISAME: bindings.worker(CANARY_PUBLISHER_BINDING),
    };
  }

  if (settings.workflowInvoker) {
    return {
      KIRISAME_CALLER_ID: bindings.text(settings.callerId ?? "kirisame-live-invoker"),
      KIRISAME_API_KEY: bindings.secret(),
      KIRISAME: bindings.worker(LIVE_CANARY_PUBLISHER_BINDING),
    };
  }

  return {
    PUBLISHING_ENABLED: bindings.text(settings.publishingEnabled ? "true" : "false"),
    GITHUB_APP_ID: bindings.text("3345400"),
    GITHUB_APP_CLIENT_ID: bindings.text(""),
    GITHUB_APP_PRIVATE_KEY: bindings.secret(),
    KIRISAME_CALLER_KEYS: bindings.secret(),
    KIRISAME_SOURCE_SHA: bindings.text(settings.sourceSha),
    KIRISAME_APP_VERSION: bindings.text(settings.appVersion),
    KIRISAME_CONTRACT_VERSION: bindings.text("1"),
    KIRISAME_BUILD_TIMESTAMP: bindings.text(settings.buildTimestamp),
  };
}
