import { WorkerEntrypoint } from "cloudflare:workers";
import { validateContract } from "../contracts/validate.js";
import type { PublicationError, PublicationRequest, PublicationResult, PublisherResponse } from "../contracts/types.js";
import { asPublicationFailure, PublicationFailure } from "../errors/publication-error.js";
import { PublicationService } from "../publication/service.js";
import { createProductionPublicationService, type PublisherRuntimeEnvironment } from "../publication/runtime.js";
import { utf8 } from "../contracts/integrity.js";

export const MAX_REQUEST_BODY_BYTES = 9 * 1024 * 1024;
type Publish = (request: PublicationRequest) => Promise<PublicationResult>;

/** Private typed-RPC entrypoint. Production publishing is explicitly unavailable in this phase. */
export class PublisherEntrypoint extends WorkerEntrypoint {
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
  if (!validation.valid) {
    const version = isRecord(value) ? value.contractVersion : undefined;
    const semanticCode = validation.errors.find((item) => item.source === "semantic")?.code;
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

  const application = publish instanceof PublicationService
    ? (candidate: PublicationRequest) => publish.publish(candidate)
    : publish;
  try {
    const result = await application(value as PublicationRequest);
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
    return result;
  } catch (error) {
    const failure = asPublicationFailure(error);
    const requestRecord = isRecord(value) ? value : undefined;
    console.warn(JSON.stringify({
      operation: "publication",
      requestId,
      ...(typeof requestRecord?.publicationId === "string" ? { publicationId: requestRecord.publicationId } : {}),
      ...(typeof requestRecord?.runId === "string" ? { runId: requestRecord.runId } : {}),
      code: failure.code,
      classification: failure.classification,
      retryable: failure.classification === "retryable",
      durationMs: Date.now() - startedAt,
    }));
    return failure.toContractError(requestId);
  }
}

export async function unavailableResult(request: PublicationRequest): Promise<PublicationResult> {
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
