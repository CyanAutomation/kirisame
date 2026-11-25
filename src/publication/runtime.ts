import { PublicationFailure } from "../errors/publication-error.js";
import {
  createGitHubAppJwt,
  diagnoseGitHubAppPrivateKey,
  importGitHubAppPrivateKey,
  type GitHubAppCredentials,
  validateGitHubAppCredentials,
} from "../github/GitHubAppAuth.js";
import { RealGitHubAdapter } from "../github/RealGitHubAdapter.js";
import { CANARY_PUBLICATION_TARGET } from "../shared/canary-target.js";
import type { CanaryAuthorizationDiagnosticStep, CanaryAuthorizationResult } from "../contracts/types.js";
import { hasConfiguredPublisherCallers } from "./caller-auth.js";
import { runAuthorizationPreflightStage } from "./authorization-preflight.js";
import { PublicationService } from "./service.js";

export interface PublisherRuntimeEnvironment extends Record<string, unknown> {
  PUBLISHING_ENABLED?: unknown;
  GITHUB_APP_ID?: unknown;
  GITHUB_APP_CLIENT_ID?: unknown;
  GITHUB_APP_PRIVATE_KEY?: unknown;
  KIRISAME_CALLER_KEYS?: unknown;
}

export interface PublicationDiagnosticContext {
  requestId: string;
  publicationId: string;
}

interface PublicationSettings {
  appId: string | undefined;
  clientId: string | undefined;
  privateKey: string | undefined;
}

export async function createProductionPublicationService(
  environment: PublisherRuntimeEnvironment,
  diagnosticContext?: PublicationDiagnosticContext,
): Promise<PublicationService> {
  if (environment.PUBLISHING_ENABLED !== "true") throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  const { appId, clientId, privateKey } = readPublicationSettings(environment);
  if (!appId || !privateKey) throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  const credentials: GitHubAppCredentials = { appId, privateKey, ...(clientId ? { clientId } : {}) };
  validateGitHubAppCredentials(credentials);
  await importGitHubAppPrivateKey(privateKey);
  return new PublicationService(new RealGitHubAdapter(credentials, diagnosticContext));
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

  const keyImport = await diagnoseGitHubAppPrivateKey(credentials.privateKey);
  if (!keyImport.ok) {
    return { status: "rejected", code: "PUBLISHING_UNAVAILABLE", failureStage: keyImport.failureStage };
  }

  const signing = await runAuthorizationPreflightStage("github_app_signing", async () => {
    await createGitHubAppJwt(credentials!);
  });
  if (!signing.ok) return rejectedAuthorization(signing);

  let diagnostic: { step: CanaryAuthorizationDiagnosticStep; httpStatus?: number } = { step: "installation_lookup" };
  const installationScope = await runAuthorizationPreflightStage("installation_and_token_scope", async () => {
    await new RealGitHubAdapter(credentials!, {
      fetch: fetcher,
      onAuthorizationDiagnostic: (step, httpStatus) => {
        diagnostic = { step, ...(httpStatus !== undefined ? { httpStatus } : {}) };
      },
    }).resolveRepository(
      { owner: CANARY_PUBLICATION_TARGET.owner, name: CANARY_PUBLICATION_TARGET.repository },
      "pr",
    );
  });
  if (!installationScope.ok) return rejectedAuthorization(installationScope, diagnostic);

  return { status: "verified", repository: "CyanAutomation/somatic" };
}

function rejectedAuthorization(
  result: Exclude<Awaited<ReturnType<typeof runAuthorizationPreflightStage>>, { ok: true }>,
  diagnostic?: { step: CanaryAuthorizationDiagnosticStep; httpStatus?: number },
): CanaryAuthorizationResult {
  return {
    status: "rejected",
    code: result.code,
    failureStage: result.failureStage,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

export async function isProductionPublishingConfigured(environment: unknown): Promise<boolean> {
  if (!isRecord(environment) || environment.PUBLISHING_ENABLED !== "true") return false;
  try {
    const { appId, clientId, privateKey } = readPublicationSettings(environment);
    if (!appId || !privateKey || !hasConfiguredPublisherCallers(environment.KIRISAME_CALLER_KEYS)) return false;
    const credentials: GitHubAppCredentials = { appId, privateKey, ...(clientId ? { clientId } : {}) };
    validateGitHubAppCredentials(credentials);
    await importGitHubAppPrivateKey(privateKey);
    return true;
  } catch {
    return false;
  }
}

function readPublicationSettings(environment: Record<string, unknown>): PublicationSettings {
  return {
    appId: stringValue(environment.GITHUB_APP_ID),
    clientId: stringValue(environment.GITHUB_APP_CLIENT_ID),
    privateKey: stringValue(environment.GITHUB_APP_PRIVATE_KEY),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
