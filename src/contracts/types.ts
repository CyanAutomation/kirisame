export type ContractVersion = "1";

export interface Repository {
  owner: string;
  name: string;
}

export interface PublicationContent {
  mediaType: "text/plain; charset=utf-8";
  encoding: "base64";
  byteLength: number;
  sha256: string;
  data: string;
}

export type FileChange =
  | { operation: "add"; path: string; content: PublicationContent }
  | { operation: "modify"; path: string; baseBlobSha: string; content: PublicationContent }
  | { operation: "delete"; path: string; baseBlobSha: string };

export interface PublicationArtifact {
  contractVersion: ContractVersion;
  artifactId: string;
  runId: string;
  repository: Repository;
  baseRef: string;
  baseSha: string;
  fileCount: number;
  totalBytes: number;
  files: FileChange[];
}

export interface PublicationRequest {
  contractVersion: ContractVersion;
  publicationId: string;
  runId: string;
  repository: Repository;
  mode: "pr" | "branch";
  baseRef: string;
  baseSha: string;
  headRef: string;
  title?: string;
  body?: string;
  artifact: PublicationArtifact;
  artifactDigest: string;
}

export type PublicationErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_VERSION"
  | "UNAUTHORIZED_CALLER"
  | "REPOSITORY_NOT_ALLOWED"
  | "APP_NOT_INSTALLED"
  | "GITHUB_PERMISSION_DENIED"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "ARTIFACT_PROVENANCE_MISMATCH"
  | "BASE_MOVED"
  | "BASE_TREE_CONFLICT"
  | "BRANCH_CONFLICT"
  | "PULL_REQUEST_CONFLICT"
  | "NO_CHANGES"
  | "UNSUPPORTED_GIT_OBJECT"
  | "GITHUB_AUTH_UNAVAILABLE"
  | "GITHUB_AUTH_INVALID"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_UNAVAILABLE"
  | "GITHUB_TIMEOUT"
  | "RECONCILIATION_REQUIRED"
  | "PUBLISHING_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type ErrorClassification = "invalid" | "policy" | "conflict" | "retryable" | "internal";

export interface PublicationError {
  code: PublicationErrorCode;
  classification: ErrorClassification;
  message: string;
  requestId?: string;
  retryAfterSeconds?: number;
}

export interface PublicationResult {
  contractVersion: ContractVersion;
  publicationId: string;
  runId: string;
  repository: Repository;
  mode: "pr" | "branch";
  outcome: "branch_published" | "pr_published" | "retryable_failure" | "blocked";
  retryable: boolean;
  reconciliation: "not_needed" | "confirmed_absent" | "branch_confirmed" | "pull_request_confirmed" | "conflict" | "unknown";
  branch?: { ref: string; commitSha: string; reused?: boolean };
  pullRequest?: { number: number; url: string; state: "open" | "closed" | "merged" };
  error?: PublicationError;
}

export interface PublicationEvent {
  contractVersion: ContractVersion;
  eventId: string;
  publicationId: string;
  runId: string;
  occurredAt: string;
  source: "soyuz" | "kirisame";
  type:
    | "publication.requested"
    | "publication.started"
    | "publication.branch_published"
    | "publication.pull_request_created"
    | "publication.retryable_failure"
    | "publication.blocked"
    | "publication.reconciled";
  state: "pending" | "publishing" | "published" | "retryable_failure" | "blocked";
  repository?: Repository;
  branchRef?: string;
  commitSha?: string;
  pullRequestNumber?: number;
  errorCode?: PublicationErrorCode;
}

export type ContractType =
  | "publication-artifact"
  | "publication-error"
  | "publication-event"
  | "publication-request"
  | "publication-result";

export interface ValidationIssue {
  source: "schema" | "semantic";
  keyword?: string;
  instancePath?: string;
  params?: Record<string, unknown>;
  code?: string;
  message?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

export type PublisherResponse = PublicationResult | PublicationError;

export type CanaryAuthorizationFailureStage =
  | "configuration"
  | "private_key_import"
  | "github_app_signing"
  | "installation_and_token_scope"
  | "internal";

export type CanaryAuthorizationResult =
  | { status: "verified"; repository: "CyanAutomation/somatic" }
  | {
    status: "rejected";
    code: PublicationErrorCode;
    failureStage: CanaryAuthorizationFailureStage;
  };
