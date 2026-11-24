import { describe, expect, it } from "vitest";
import { resolveWorkerSettings } from "../../src/publication/worker-settings.js";
import {
  CANARY_PUBLISHER_BINDING,
  LIVE_CANARY_PUBLISHER_BINDING,
  LIVE_CANARY_WORKER_EXPOSURE,
  LIVE_CANARY_WORKFLOW,
  resolveCanarySettings,
} from "../../src/publication/canary-settings.js";

describe("Cloudflare worker settings", () => {
  const canary = resolveCanarySettings({
    KIRISAME_CANARY_ENABLED: "true",
    KIRISAME_CANARY_REPOSITORY: "CyanAutomation/somatic",
    KIRISAME_CANARY_BASE_REF: "main",
  });

  it("keeps the local canary on the existing private production publisher binding", () => {
    expect(CANARY_PUBLISHER_BINDING).toEqual({
      worker: "kirisame",
      exportName: "PublisherEntrypoint",
      dev: { remote: true },
    });
  });

  it("keeps the canary harness isolated from publication receiver settings", () => {
    expect(resolveWorkerSettings("canary-harness", canary, {})).toMatchObject({
      workerName: "kirisame-canary-harness",
      canaryHarness: true,
      publishingEnabled: false,
      repositoryAllowlist: "[]",
    });
  });

  it("enables publication only on an enabled canary receiver", () => {
    expect(resolveWorkerSettings("canary-receiver", canary, { GITHUB_SHA: "abc123" })).toMatchObject({
      workerName: "kirisame-canary",
      canaryHarness: false,
      publishingEnabled: true,
      repositoryAllowlist: canary.allowlist,
      sourceSha: "abc123",
    });
    expect(resolveWorkerSettings("production", canary, {})).toMatchObject({
      workerName: "kirisame",
      publishingEnabled: false,
      repositoryAllowlist: "[]",
    });
    expect(resolveWorkerSettings("production", canary, {
      PUBLISHING_ENABLED: "true",
      GITHUB_REPOSITORY_ALLOWLIST: '[{"owner":"CyanAutomation","repository":"somatic","operations":["pr"],"baseBranches":["main"]}]',
    })).toMatchObject({
      workerName: "kirisame",
      publishingEnabled: true,
      repositoryAllowlist: '[{"owner":"CyanAutomation","repository":"somatic","operations":["pr"],"baseBranches":["main"]}]',
    });
  });

  it("configures the deployed live test invoker without enabling publisher settings", () => {
    expect(resolveWorkerSettings("live-canary-invoker", canary, {})).toMatchObject({
      workerName: "kirisame-live-invoker",
      canaryHarness: false,
      workflowInvoker: true,
      publishingEnabled: false,
      repositoryAllowlist: "[]",
    });
  });

  it("uses a private, unscheduled Workflow with only a production Kirisame Service Binding", () => {
    expect(LIVE_CANARY_PUBLISHER_BINDING).toEqual({
      worker: "kirisame",
      exportName: "PublisherEntrypoint",
    });
    expect(LIVE_CANARY_WORKFLOW).toEqual({
      name: "kirisame-live-invoker",
      exportName: "LiveCanaryWorkflow",
      maxSteps: 2,
      concurrencyLimit: 1,
      retention: "1 day",
    });
    expect(LIVE_CANARY_WORKER_EXPOSURE).toEqual({
      workersDev: false,
      previewUrls: false,
      triggers: [],
    });
  });

  it("uses stable fallbacks for missing build metadata", () => {
    expect(resolveWorkerSettings(undefined, canary, {})).toMatchObject({
      workerName: "kirisame",
      appVersion: "0.1.0",
      sourceSha: "unknown",
      buildTimestamp: "unknown",
    });
  });
});
