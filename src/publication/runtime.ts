import { PublicationFailure } from "../errors/publication-error.js";
import {
  createGitHubAppJwt,
  importGitHubAppPrivateKey,
  type GitHubAppCredentials,
  validateGitHubAppCredentials,
} from "../github/GitHubAppAuth.js";
import { RealGitHubAdapter } from "../github/RealGitHubAdapter.js";
import { CANARY_PUBLICATION_TARGET } from "../shared/canary-target.js";
import type { CanaryAuthorizationResult } from "../contracts/types.js";
import { runAuthorizationPreflightStage } from "./authorization-preflight.js";
import { PublicationService } from "./service.js";
import { parseRepositoryAllowlist } from "./allowlist.js";
import { RepositoryAllowlistPolicy } from "./policy.js";

export interface PublisherRuntimeEnvironment extends Record<string, unknown> {
  PUBLISHING_ENABLED?: unknown;
  GITHUB_APP_ID?: unknown;
  GITHUB_APP_CLIENT_ID?: unknown;
  GITHUB_APP_PRIVATE_KEY?: unknown;
  GITHUB_REPOSITORY_ALLOWLIST?: unknown;
}

interface PublicationSettings {
  appId: string | undefined;
  clientId: string | undefined;
  privateKey: string | undefined;
  allowlistJson: string | undefined;
}

export async function createProductionPublicationService(environment: PublisherRuntimeEnvironment): Promise<PublicationService> {
  if (environment.PUBLISHING_ENABLED !== "true") throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  const { appId, clientId, privateKey, allowlistJson } = readPublicationSettings(environment);
  if (!appId || !privateKey || !allowlistJson) throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  const credentials: GitHubAppCredentials = { appId, privateKey, ...(clientId ? { clientId } : {}) };
  validateGitHubAppCredentials(credentials);
  await importGitHubAppPrivateKey(privateKey);
  const rules = parseRepositoryAllowlist(allowlistJson);
  if (rules.length === 0) throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  return new PublicationService(new RealGitHubAdapter(credentials), new RepositoryAllowlistPolicy(rules));
}

/** Read-only fixed-scope App and installation-token preflight; deliberately independent of the publishing gate. */
export async function verifyCanaryRepositoryAuthorization(
  environment: PublisherRuntimeEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<CanaryAuthorizationResult> {
  let credentials: GitHubAppCredentials | undefined;
  const configuration = await runAuthorizationPreflightStage("configuration", () => {
    const { appId, clientId, privateKey } = readPublicationSettings(environment);
    if (!appId || !privateKey) throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
    credentials = { appId, privateKey, ...(clientId ? { clientId } : {}) };
    validateGitHubAppCredentials(credentials);
  });
  if (!configuration.ok) return rejectedAuthorization(configuration);
  if (!credentials) {
    return { status: "rejected", code: "INTERNAL_ERROR", failureStage: "internal" };
  }

  const keyImport = await runAuthorizationPreflightStage("private_key_import", async () => {
    await importGitHubAppPrivateKey(credentials!.privateKey);
  });
  if (!keyImport.ok) return rejectedAuthorization(keyImport);

  const signing = await runAuthorizationPreflightStage("github_app_signing", async () => {
    await createGitHubAppJwt(credentials!);
  });
  if (!signing.ok) return rejectedAuthorization(signing);

  const installationScope = await runAuthorizationPreflightStage("installation_and_token_scope", async () => {
    await new RealGitHubAdapter(credentials!, { fetch: fetcher }).resolveRepository(
      { owner: CANARY_PUBLICATION_TARGET.owner, name: CANARY_PUBLICATION_TARGET.repository },
      "pr",
    );
  });
  if (!installationScope.ok) return rejectedAuthorization(installationScope);

  return { status: "verified", repository: "CyanAutomation/somatic" };
}

function rejectedAuthorization(
  result: Exclude<Awaited<ReturnType<typeof runAuthorizationPreflightStage>>, { ok: true }>,
): CanaryAuthorizationResult {
  return { status: "rejected", code: result.code, failureStage: result.failureStage };
}

export async function isProductionPublishingConfigured(environment: unknown): Promise<boolean> {
  if (!isRecord(environment) || environment.PUBLISHING_ENABLED !== "true") return false;
  try {
    const { appId, clientId, privateKey, allowlistJson } = readPublicationSettings(environment);
    if (!appId || !privateKey || !allowlistJson) return false;
    const credentials: GitHubAppCredentials = { appId, privateKey, ...(clientId ? { clientId } : {}) };
    validateGitHubAppCredentials(credentials);
    await importGitHubAppPrivateKey(privateKey);
    return parseRepositoryAllowlist(allowlistJson).length > 0;
  } catch {
    return false;
  }
}

function readPublicationSettings(environment: Record<string, unknown>): PublicationSettings {
  return {
    appId: stringValue(environment.GITHUB_APP_ID),
    clientId: stringValue(environment.GITHUB_APP_CLIENT_ID),
    privateKey: stringValue(environment.GITHUB_APP_PRIVATE_KEY),
    allowlistJson: stringValue(environment.GITHUB_REPOSITORY_ALLOWLIST),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
