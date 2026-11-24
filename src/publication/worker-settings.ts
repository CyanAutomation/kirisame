import type { CanarySettings } from "./canary-settings.js";

export interface WorkerSettings {
  workerName: string;
  canaryHarness: boolean;
  workflowInvoker: boolean;
  canaryEnabled: boolean;
  canaryRepository: string;
  canaryBaseRef: string;
  canaryAllowlist: string;
  publishingEnabled: boolean;
  repositoryAllowlist: string;
  sourceSha: string;
  appVersion: string;
  buildTimestamp: string;
}

export function resolveWorkerSettings(
  mode: string | undefined,
  canary: CanarySettings,
  environment: Record<string, string | undefined> | undefined,
): WorkerSettings {
  const canaryHarness = mode === "canary-harness";
  const canaryReceiver = mode === "canary-receiver";
  const workflowInvoker = mode === "live-canary-invoker";
  const publishingEnabled = canaryReceiver ? canary.enabled : environment?.PUBLISHING_ENABLED === "true";

  return {
    workerName: canaryHarness ? "kirisame-canary-harness"
      : canaryReceiver ? "kirisame-canary"
        : workflowInvoker ? "kirisame-live-invoker" : "kirisame",
    canaryHarness,
    workflowInvoker,
    canaryEnabled: canary.enabled,
    canaryRepository: canary.repository,
    canaryBaseRef: canary.baseRef,
    canaryAllowlist: canary.allowlist,
    publishingEnabled,
    repositoryAllowlist: canaryReceiver ? canary.allowlist
      : publishingEnabled ? environment?.GITHUB_REPOSITORY_ALLOWLIST ?? "[]" : "[]",
    sourceSha: environment?.GITHUB_SHA ?? "unknown",
    appVersion: environment?.KIRISAME_APP_VERSION ?? "0.1.0",
    buildTimestamp: environment?.KIRISAME_BUILD_TIMESTAMP ?? "unknown",
  };
}
