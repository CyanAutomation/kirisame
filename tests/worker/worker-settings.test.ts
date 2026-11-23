import { describe, expect, it } from "vitest";
import { resolveWorkerSettings } from "../../src/publication/worker-settings.js";
import { resolveCanarySettings } from "../../src/publication/canary-settings.js";

describe("Cloudflare worker settings", () => {
  const canary = resolveCanarySettings({
    KIRISAME_CANARY_ENABLED: "true",
    KIRISAME_CANARY_REPOSITORY: "CyanAutomation/demo-app",
    KIRISAME_CANARY_BASE_REF: "main",
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
