import type { ErrorClassification, PublicationError, PublicationErrorCode } from "../contracts/types.js";
import { ERROR_CLASSIFICATIONS } from "../contracts/semantic.js";

const SAFE_MESSAGES: Record<PublicationErrorCode, string> = {
  INVALID_REQUEST: "The publication request is invalid.",
  UNSUPPORTED_VERSION: "The publication contract version is not supported.",
  UNAUTHORIZED_CALLER: "The publication caller is not authorized.",
  REPOSITORY_NOT_ALLOWED: "The requested repository is not allowed.",
  APP_NOT_INSTALLED: "The publishing application is not installed for this repository.",
  GITHUB_PERMISSION_DENIED: "The publishing application lacks the required repository permission.",
  ARTIFACT_INVALID: "The publication artifact is invalid or uses an unsupported feature.",
  ARTIFACT_DIGEST_MISMATCH: "The artifact digest does not match the supplied artifact.",
  ARTIFACT_PROVENANCE_MISMATCH: "The artifact does not match the authorized execution.",
  BASE_MOVED: "The requested base branch moved before this publication was complete.",
  BASE_TREE_CONFLICT: "The artifact changes conflict with the requested base tree.",
  BRANCH_CONFLICT: "The deterministic publication branch already contains different content.",
  PULL_REQUEST_CONFLICT: "A conflicting or closed pull request already exists for this publication.",
  UNSUPPORTED_GIT_OBJECT: "The requested change touches a Git object or file mode outside the supported contract.",
  GITHUB_AUTH_UNAVAILABLE: "GitHub authentication is temporarily unavailable.",
  GITHUB_RATE_LIMITED: "GitHub rate limits temporarily prevent publication.",
  GITHUB_UNAVAILABLE: "GitHub is temporarily unavailable.",
  GITHUB_TIMEOUT: "The GitHub operation timed out and must be reconciled.",
  RECONCILIATION_REQUIRED: "The GitHub outcome is uncertain and must be reconciled before retrying.",
  PUBLISHING_UNAVAILABLE: "GitHub publishing is not enabled in this deployment.",
  INTERNAL_ERROR: "An internal publication error occurred.",
};

export class PublicationFailure extends Error {
  readonly code: PublicationErrorCode;
  readonly classification: ErrorClassification;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: PublicationErrorCode, options: { retryAfterSeconds?: number } = {}) {
    super(SAFE_MESSAGES[code]);
    this.name = "PublicationFailure";
    this.code = code;
    this.classification = ERROR_CLASSIFICATIONS[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  toContractError(requestId?: string): PublicationError {
    return {
      code: this.code,
      classification: this.classification,
      message: SAFE_MESSAGES[this.code],
      ...(requestId ? { requestId } : {}),
      ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
    };
  }
}

export function asPublicationFailure(error: unknown): PublicationFailure {
  if (error instanceof PublicationFailure) return error;
  return new PublicationFailure("INTERNAL_ERROR");
}

export function isPublicationFailure(error: unknown): error is PublicationFailure {
  return error instanceof PublicationFailure;
}
