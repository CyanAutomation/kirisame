import { WorkerEntrypoint } from "cloudflare:workers";
import { validateContract } from "../contracts/validate.js";
import type {
  CanaryAuthorizationResult,
  PublicationError,
  PublicationRequest,
  PublicationResult,
  PublisherResponse,
  ValidationIssue,
} from "../contracts/types.js";
import { asPublicationFailure, PublicationFailure } from "../errors/publication-error.js";
import { PublicationService } from "../publication/service.js";
import {
  createProductionPublicationService,
  verifyCanaryRepositoryAuthorization,
  type PublisherRuntimeEnvironment,
} from "../publication/runtime.js";
import { utf8 } from "../contracts/integrity.js";

export const MAX_REQUEST_BODY_BYTES = 9 * 1024 * 1024;
type Publish = (request: PublicationRequest) => Promise<PublicationResult>;

/** Private typed-RPC entrypoint. Production publishing is explicitly unavailable in this phase. */
export class PublisherEntrypoint extends WorkerEntrypoint {
  // fallow-ignore-next-line unused-class-member -- Invoked by a private Cloudflare Worker Service Binding.
  async verifyCanaryAuthorization(): Promise<CanaryAuthorizationResult> {
    try {
      await verifyCanaryRepositoryAuthorization(this.env as unknown as PublisherRuntimeEnvironment);
      return { status: "verified", repository: "CyanAutomation/somatic" };
    } catch (error) {
      return { status: "rejected", code: asPublicationFailure(error).code };
    }
  }

  async publish(requestJson: string): Promise<PublisherResponse> {
    const environment = this.env as unknown as PublisherRuntimeEnvironment;
    return handlePublisherJson(requestJson, async (request) => {
      if (environment.PUBLISHING_ENABLED !== "true") return unavailableResult(request);
      const service = await createProductionPublicationService(environment);
      return service.publish(request);
    });
  }
}

/** Shared parser used by the production named entrypoint and its test-only mock binding. */
export async function handlePublisherJson(
  requestJson: string,
  publish: Publish | PublicationService,
): Promise<PublisherResponse> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const value = await parsePublisherRequest(requestJson, requestId);
  if (isPublicationError(value)) return value;
  const application = publicationFunction(publish);
  try {
    const result = await application(value);
    logPublicationSuccess(result, requestId, startedAt);
    return result;
  } catch (error) {
    const failure = asPublicationFailure(error);
    logPublicationFailure(value, failure, requestId, startedAt);
    return failure.toContractError(requestId);
  }
}

async function parsePublisherRequest(requestJson: unknown, requestId: string): Promise<PublicationRequest | PublicationError> {
  if (typeof requestJson !== "string") {
    return invalidResponse("INVALID_REQUEST", "The private RPC payload must be a JSON string.", requestId);
  }
  if (utf8(requestJson).byteLength > MAX_REQUEST_BODY_BYTES) {
    return invalidResponse("ARTIFACT_INVALID", "The publication request body exceeds 9 MiB.", requestId);
  }

  let value: unknown;
  try {
    value = JSON.parse(requestJson);
  } catch {
    return invalidResponse("INVALID_REQUEST", "The request body must be valid JSON.", requestId);
  }

  const validation = await validateContract("publication-request", value);
  return validation.valid ? value as PublicationRequest : invalidValidationResponse(value, validation.errors, requestId);
}

function invalidValidationResponse(value: unknown, errors: ValidationIssue[], requestId: string): PublicationError {
  const version = isRecord(value) ? value.contractVersion : undefined;
  const semanticCode = errors.find((item) => item.source === "semantic")?.code;
  if (version !== undefined && version !== "1") {
    return invalidResponse("UNSUPPORTED_VERSION", "The publication contract version is not supported.", requestId);
  }
  if (semanticCode === "ARTIFACT_DIGEST_MISMATCH") {
    return invalidResponse("ARTIFACT_DIGEST_MISMATCH", "The artifact digest does not match the supplied artifact.", requestId);
  }
  if (semanticCode === "ARTIFACT_PROVENANCE_MISMATCH") {
    return invalidResponse("ARTIFACT_PROVENANCE_MISMATCH", "The artifact does not match the authorized execution.", requestId);
  }
  if (semanticCode === "UNSUPPORTED_GIT_ATTRIBUTES_CHANGE") {
    return new PublicationFailure("UNSUPPORTED_GIT_OBJECT").toContractError(requestId);
  }
  return invalidResponse(semanticCode ? "ARTIFACT_INVALID" : "INVALID_REQUEST", "The publication request failed contract validation.", requestId);
}

function isPublicationError(value: PublicationRequest | PublicationError): value is PublicationError {
  return "code" in value;
}

function publicationFunction(publish: Publish | PublicationService): Publish {
  return publish instanceof PublicationService
    ? (candidate) => publish.publish(candidate)
    : publish;
}

function logPublicationSuccess(result: PublicationResult, requestId: string, startedAt: number): void {
  console.info(JSON.stringify({
    operation: "publication",
    requestId,
    publicationId: result.publicationId,
    runId: result.runId,
    mode: result.mode,
    outcome: result.outcome,
    retryable: result.retryable,
    reconciliation: result.reconciliation,
    durationMs: Date.now() - startedAt,
  }));
}

function logPublicationFailure(
  request: PublicationRequest,
  failure: PublicationFailure,
  requestId: string,
  startedAt: number,
): void {
  console.warn(JSON.stringify({
    operation: "publication",
    requestId,
    publicationId: request.publicationId,
    runId: request.runId,
    code: failure.code,
    classification: failure.classification,
    retryable: failure.classification === "retryable",
    durationMs: Date.now() - startedAt,
  }));
}

async function unavailableResult(request: PublicationRequest): Promise<PublicationResult> {
  return {
    contractVersion: "1",
    publicationId: request.publicationId,
    runId: request.runId,
    repository: { ...request.repository },
    mode: request.mode,
    outcome: "blocked",
    retryable: false,
    reconciliation: "not_needed",
    error: new PublicationFailure("PUBLISHING_UNAVAILABLE").toContractError(),
  };
}

function invalidResponse(
  code: "INVALID_REQUEST" | "UNSUPPORTED_VERSION" | "ARTIFACT_INVALID" | "ARTIFACT_DIGEST_MISMATCH" | "ARTIFACT_PROVENANCE_MISMATCH",
  message: string,
  requestId: string,
): PublicationError {
  const failure = new PublicationFailure(code);
  return { ...failure.toContractError(requestId), message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
