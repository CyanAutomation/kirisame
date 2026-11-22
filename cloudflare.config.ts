import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import * as canaryHarnessEntrypoint from "./src/canary/harness.ts" with { type: "cf-worker" };

const processEnvironment = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;
const canaryRepository = processEnvironment?.KIRISAME_CANARY_REPOSITORY?.trim() ?? "";
const canaryBaseRef = processEnvironment?.KIRISAME_CANARY_BASE_REF?.trim() ?? "";
const [canaryOwner, canaryName, canaryExtra] = canaryRepository.split("/");
const canaryTargetApproved = processEnvironment?.KIRISAME_CANARY_ENABLED === "true"
  && Boolean(canaryOwner && canaryName && canaryExtra === undefined && canaryBaseRef);
const canaryAllowlist = canaryTargetApproved
  ? JSON.stringify([{ owner: canaryOwner, repository: canaryName, operations: ["pr"], baseBranches: [canaryBaseRef] }])
  : "[]";

export default defineConfig(({ mode }) => {
  const canaryHarness = mode === "canary-harness";
  const canaryReceiver = mode === "canary-receiver";
  const env = canaryHarness
    ? {
      KIRISAME_CANARY_ENABLED: bindings.text(canaryTargetApproved ? "true" : "false"),
      KIRISAME_CANARY_REPOSITORY: bindings.text(canaryRepository),
      KIRISAME_CANARY_BASE_REF: bindings.text(canaryBaseRef),
      KIRISAME: bindings.worker({
        worker: "kirisame-canary",
        exportName: "PublisherEntrypoint",
        dev: { remote: true },
      }),
    }
    : {
      PUBLISHING_ENABLED: bindings.text(canaryReceiver && canaryTargetApproved ? "true" : "false"),
      GITHUB_APP_ID: bindings.text("3345400"),
      GITHUB_APP_CLIENT_ID: bindings.text(""),
      GITHUB_REPOSITORY_ALLOWLIST: bindings.text(canaryReceiver ? canaryAllowlist : "[]"),
      GITHUB_APP_PRIVATE_KEY: bindings.secret(),
      KIRISAME_SOURCE_SHA: bindings.text(processEnvironment?.GITHUB_SHA ?? "unknown"),
      KIRISAME_APP_VERSION: bindings.text(processEnvironment?.KIRISAME_APP_VERSION ?? "0.1.0"),
      KIRISAME_CONTRACT_VERSION: bindings.text("1"),
      KIRISAME_BUILD_TIMESTAMP: bindings.text(processEnvironment?.KIRISAME_BUILD_TIMESTAMP ?? "unknown"),
    };

  return {
    accountId: "c40f3cb30efbf8c6d081cf9e50a61931",
    worker: {
      name: canaryHarness ? "kirisame-canary-harness" : canaryReceiver ? "kirisame-canary" : "kirisame",
      entrypoint: canaryHarness ? canaryHarnessEntrypoint : entrypoint,
      compatibilityDate: "2026-11-22",
      env,
      observability: {
        enabled: true,
        logs: { enabled: true, headSamplingRate: 0.2, invocationLogs: true },
        traces: { enabled: true, headSamplingRate: 0.05 },
      },
    },
  };
});
