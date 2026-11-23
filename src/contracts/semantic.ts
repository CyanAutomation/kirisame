import { canonicalizeJson } from "./canonicalize.js";
import { canonicalBase64ToBytes, compareUtf8, sha256Hex, utf8 } from "./integrity.js";
import type {
  ContractType,
  PublicationArtifact,
  PublicationError,
  PublicationEvent,
  PublicationRequest,
  PublicationResult,
  ValidationIssue,
} from "./types.js";

export const ERROR_CLASSIFICATIONS = {
  INVALID_REQUEST: "invalid",
  UNSUPPORTED_VERSION: "invalid",
  UNAUTHORIZED_CALLER: "policy",
  REPOSITORY_NOT_ALLOWED: "policy",
  APP_NOT_INSTALLED: "policy",
  GITHUB_PERMISSION_DENIED: "policy",
  ARTIFACT_INVALID: "invalid",
  ARTIFACT_DIGEST_MISMATCH: "invalid",
  ARTIFACT_PROVENANCE_MISMATCH: "policy",
  BASE_MOVED: "conflict",
  BASE_TREE_CONFLICT: "conflict",
  BRANCH_CONFLICT: "conflict",
  PULL_REQUEST_CONFLICT: "conflict",
  NO_CHANGES: "conflict",
  UNSUPPORTED_GIT_OBJECT: "invalid",
  GITHUB_AUTH_UNAVAILABLE: "retryable",
  GITHUB_AUTH_INVALID: "policy",
  GITHUB_RATE_LIMITED: "retryable",
  GITHUB_UNAVAILABLE: "retryable",
  GITHUB_TIMEOUT: "retryable",
  RECONCILIATION_REQUIRED: "retryable",
  PUBLISHING_UNAVAILABLE: "internal",
  INTERNAL_ERROR: "internal",
} as const;

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const unsafeUnicode = /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}]/u;
const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const eventRules: Record<PublicationEvent["type"], { source: PublicationEvent["source"][]; state: PublicationEvent["state"][] }> = {
  "publication.requested": { source: ["soyuz"], state: ["pending"] },
  "publication.started": { source: ["kirisame"], state: ["publishing"] },
  "publication.branch_published": { source: ["kirisame"], state: ["publishing", "published"] },
  "publication.pull_request_created": { source: ["kirisame"], state: ["published"] },
  "publication.retryable_failure": { source: ["kirisame"], state: ["retryable_failure"] },
  "publication.blocked": { source: ["kirisame"], state: ["blocked"] },
  "publication.reconciled": { source: ["kirisame"], state: ["published", "retryable_failure", "blocked"] },
};

function issue(code: string, message: string): ValidationIssue {
  return { source: "semantic", code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsafePath(path: string): boolean {
  const segments = path.split("/");
  return path.startsWith("/")
    || path.includes("\\")
    || path.includes(":")
    || path.normalize("NFC") !== path
    || unsafeUnicode.test(path)
    || segments.some((segment) => segment === "" || segment === "." || segment === ".."
      || segment.toLowerCase() === ".git"
      || /[. ]$/.test(segment)
      || windowsDeviceName.test(segment))
    || utf8(path).byteLength > 1024;
}

type ArtifactFile = PublicationArtifact["files"][number];

interface ArtifactFileResult {
  errors: ValidationIssue[];
  foldedPath: string;
  bytes: number;
}

async function artifactErrors(value: unknown): Promise<ValidationIssue[]> {
  if (!isRecord(value) || !Array.isArray(value.files)) return [];
  const artifact = value as unknown as PublicationArtifact;
  const errors: ValidationIssue[] = [];
  if (artifact.fileCount !== artifact.files.length) errors.push(issue("FILE_COUNT_MISMATCH", "fileCount must equal files.length"));

  let totalBytes = 0;
  const foldedPaths = new Set<string>();
  const decoded: Array<{ path: string; foldedPath: string }> = [];
  for (const file of artifact.files) {
    const result = await artifactFileErrors(file, foldedPaths);
    errors.push(...result.errors);
    totalBytes += result.bytes;
    decoded.push({ path: file.path, foldedPath: result.foldedPath });
  }

  errors.push(...artifactSizeErrors(artifact, totalBytes));
  errors.push(...artifactManifestErrors(artifact));
  errors.push(...artifactPathOrderErrors(artifact.files, decoded, foldedPaths));
  return errors;
}

async function artifactFileErrors(file: ArtifactFile, foldedPaths: Set<string>): Promise<ArtifactFileResult> {
  const errors: ValidationIssue[] = [];
  const path = file.path;
  const foldedPath = path.toLowerCase().normalize("NFC");
  if (unsafePath(path)) errors.push(issue("UNSAFE_PATH", "path must be normalized, bounded, relative POSIX text outside Git metadata"));
  if (foldedPaths.has(foldedPath)) errors.push(issue("DUPLICATE_OR_CONFLICTING_PATH", "file paths must be unique, including case-folded collisions"));
  foldedPaths.add(foldedPath);
  if (foldedPath === ".github/workflows" || foldedPath.startsWith(".github/workflows/")) {
    errors.push(issue("UNSUPPORTED_WORKFLOW_PATH", "GitHub Actions workflow files are outside the publication contract"));
  }
  if (foldedPath === ".gitattributes" || foldedPath.endsWith("/.gitattributes")) {
    errors.push(issue("UNSUPPORTED_GIT_ATTRIBUTES_CHANGE", "Changes to .gitattributes are outside the publication contract"));
  }

  const bytes = await artifactContentErrors(file, errors);
  return { errors, foldedPath, bytes };
}

async function artifactContentErrors(file: ArtifactFile, errors: ValidationIssue[]): Promise<number> {
  if (!("content" in file)) return 0;
  const bytes = canonicalBase64ToBytes(file.content.data);
  if (!bytes) {
    errors.push(issue("INVALID_BASE64", "content.data must use canonical padded RFC 4648 base64"));
    return 0;
  }
  if (bytes.byteLength !== file.content.byteLength) errors.push(issue("CONTENT_LENGTH_MISMATCH", "content.byteLength must match decoded bytes"));
  if (bytes.byteLength > MAX_FILE_BYTES) errors.push(issue("FILE_TOO_LARGE", "decoded file content exceeds 1 MiB"));
  if (await sha256Hex(bytes) !== file.content.sha256) errors.push(issue("CONTENT_DIGEST_MISMATCH", "content.sha256 must match decoded bytes"));
  validateTextContent(bytes, errors);
  return bytes.byteLength;
}

function validateTextContent(bytes: Uint8Array, errors: ValidationIssue[]): void {
  try {
    const text = textDecoder.decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new TypeError("control byte");
    if (text.startsWith("version https://git-lfs.github.com/spec/v1\n")) {
      errors.push(issue("UNSUPPORTED_LFS_POINTER", "Git LFS pointer content is outside the publication contract"));
    }
  } catch {
    errors.push(issue("UNSUPPORTED_FILE_TYPE", "file content must be valid UTF-8 text without binary control bytes"));
  }
}

function artifactSizeErrors(artifact: PublicationArtifact, totalBytes: number): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  if (artifact.totalBytes !== totalBytes) errors.push(issue("TOTAL_BYTES_MISMATCH", "totalBytes must equal the decoded content byte total"));
  if (totalBytes > MAX_TOTAL_BYTES) errors.push(issue("ARTIFACT_TOO_LARGE", "decoded artifact bytes exceed 5 MiB"));
  return errors;
}

function artifactManifestErrors(artifact: PublicationArtifact): ValidationIssue[] {
  const canonical = canonicalizeJson(artifact);
  return canonical === undefined || utf8(canonical).byteLength > MAX_MANIFEST_BYTES
    ? [issue("MANIFEST_TOO_LARGE", "canonical manifest exceeds 8 MiB or is not canonicalizable")]
    : [];
}

function artifactPathOrderErrors(
  files: ArtifactFile[],
  decoded: Array<{ path: string; foldedPath: string }>,
  foldedPaths: Set<string>,
): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const sorted = [...decoded].sort((left, right) => compareUtf8(left.path, right.path));
  if (sorted.some((entry, index) => entry.path !== files[index]?.path)) {
    errors.push(issue("FILES_NOT_SORTED", "files must be ordered by unsigned UTF-8 path bytes"));
  }
  for (const { foldedPath } of sorted) {
    if (hasParentFilePath(foldedPath, foldedPaths)) {
      errors.push(issue("DUPLICATE_OR_CONFLICTING_PATH", "a file path cannot also be a parent directory"));
    }
  }
  return errors;
}

function hasParentFilePath(foldedPath: string, foldedPaths: Set<string>): boolean {
  const parts = foldedPath.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    if (foldedPaths.has(parts.slice(0, index).join("/"))) return true;
  }
  return false;
}

function publicationErrorErrors(value: PublicationError): ValidationIssue[] {
  const expected = ERROR_CLASSIFICATIONS[value.code as keyof typeof ERROR_CLASSIFICATIONS];
  if (expected && expected !== value.classification) {
    return [issue("ERROR_CLASSIFICATION_MISMATCH", "classification must match the documented error code")];
  }
  if (value.retryAfterSeconds !== undefined && value.classification !== "retryable") {
    return [issue("ERROR_RETRY_AFTER_MISMATCH", "retryAfterSeconds is only valid for retryable errors")];
  }
  return [];
}

function eventErrors(event: PublicationEvent): ValidationIssue[] {
  const transitionErrors = eventTransitionErrors(event);
  if (transitionErrors.length > 0) return transitionErrors;
  const payloadErrors = eventPayloadErrors(event);
  if (payloadErrors.length > 0) return payloadErrors;
  return eventErrorCodeErrors(event);
}

function eventTransitionErrors(event: PublicationEvent): ValidationIssue[] {
  const rule = eventRules[event.type];
  if (!rule.source.includes(event.source) || !rule.state.includes(event.state)) {
    return [issue("INVALID_EVENT_TRANSITION", "event source and state must match its lifecycle type")];
  }
  return [];
}

function eventPayloadErrors(event: PublicationEvent): ValidationIssue[] {
  if (event.type === "publication.branch_published" && (!event.repository || !event.branchRef || !event.commitSha)) {
    return [issue("INVALID_EVENT_PAYLOAD", "branch publication events require repository, branchRef and commitSha")];
  }
  if (event.type === "publication.pull_request_created" && (!event.repository || !event.branchRef || !event.commitSha || !event.pullRequestNumber)) {
    return [issue("INVALID_EVENT_PAYLOAD", "pull request events require repository, branchRef, commitSha and pullRequestNumber")];
  }
  if ((event.type === "publication.retryable_failure" || event.type === "publication.blocked") && !event.errorCode) {
    return [issue("INVALID_EVENT_PAYLOAD", "failure events require an errorCode")];
  }
  return [];
}

function eventErrorCodeErrors(event: PublicationEvent): ValidationIssue[] {
  if (event.errorCode) {
    const expected = ERROR_CLASSIFICATIONS[event.errorCode as keyof typeof ERROR_CLASSIFICATIONS];
    if (expected === undefined) return [issue("INVALID_EVENT_ERROR_CODE", "event errorCode is not part of the supported taxonomy")];
    if ((event.state === "retryable_failure") !== (expected === "retryable")) {
      return [issue("INVALID_EVENT_ERROR_CLASSIFICATION", "event state must agree with its error classification")];
    }
  }
  return [];
}

export async function semanticErrors(type: ContractType, document: unknown): Promise<ValidationIssue[]> {
  if (!isRecord(document)) return [];
  switch (type) {
    case "publication-artifact":
      return artifactErrors(document);
    case "publication-request":
      return requestErrors(document as unknown as PublicationRequest);
    case "publication-error":
      return publicationErrorErrors(document as unknown as PublicationError);
    case "publication-event":
      return eventErrors(document as unknown as PublicationEvent);
    case "publication-result":
      return publicationResultErrors(document as unknown as PublicationResult);
  }
}

async function requestErrors(request: PublicationRequest): Promise<ValidationIssue[]> {
  const errors = await artifactErrors(request.artifact);
  if (request.artifact.runId !== request.runId
    || request.artifact.repository.owner !== request.repository.owner
    || request.artifact.repository.name !== request.repository.name
    || request.artifact.baseRef !== request.baseRef
    || request.artifact.baseSha !== request.baseSha) {
    errors.push(issue("ARTIFACT_PROVENANCE_MISMATCH", "artifact run, repository and base must match the request"));
  }
  const canonical = canonicalizeJson(request.artifact);
  if (canonical === undefined || `sha256:${await sha256Hex(utf8(canonical))}` !== request.artifactDigest) {
    errors.push(issue("ARTIFACT_DIGEST_MISMATCH", "artifactDigest must be SHA-256 of the RFC 8785 canonical artifact JSON"));
  }
  if (request.headRef !== `kirisame/p/${request.publicationId}`) {
    errors.push(issue("UNSAFE_HEAD_REF", "headRef must be the deterministic Kirisame publication ref"));
  }
  return errors;
}

function publicationResultErrors(result: PublicationResult): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  if (result.error) errors.push(...publicationErrorErrors(result.error));
  errors.push(...publicationOutcomeErrors(result));
  errors.push(...publicationFailureErrors(result));
  if (result.pullRequest && result.mode !== "pr") errors.push(issue("MALFORMED_RESULT", "branch mode cannot return a pull request"));
  return errors;
}

function publicationOutcomeErrors(result: PublicationResult): ValidationIssue[] {
  switch (result.outcome) {
    case "branch_published":
      return branchPublicationOutcomeErrors(result);
    case "pr_published":
      return pullRequestPublicationOutcomeErrors(result);
    case "retryable_failure":
    case "blocked":
      return result.error ? [] : [issue("MALFORMED_RESULT", "unsuccessful results require a structured error")];
  }
}

function branchPublicationOutcomeErrors(result: PublicationResult): ValidationIssue[] {
  return result.mode !== "branch" || !result.branch || result.pullRequest || result.error || result.retryable
    ? [issue("MALFORMED_RESULT", "branch_published requires branch mode and a confirmed branch only")]
    : [];
}

function pullRequestPublicationOutcomeErrors(result: PublicationResult): ValidationIssue[] {
  return result.mode !== "pr" || !result.branch || !result.pullRequest || result.pullRequest.state !== "open" || result.error || result.retryable
    ? [issue("MALFORMED_RESULT", "pr_published requires PR mode, a branch and an open pull request")]
    : [];
}

function publicationFailureErrors(result: PublicationResult): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  if (result.error) {
    const retryable = result.error.classification === "retryable";
    if (result.retryable !== retryable || result.outcome !== (retryable ? "retryable_failure" : "blocked")) {
      errors.push(issue("MALFORMED_RESULT", "outcome and retryable must agree with the structured error"));
    }
    if (result.pullRequest) errors.push(issue("MALFORMED_RESULT", "a failed result cannot contain a pull request"));
  }
  return errors;
}

export async function validateResultForRequest(requestValue: unknown, resultValue: unknown): Promise<ValidationIssue[]> {
  const errors: ValidationIssue[] = [];
  if (!isRecord(requestValue) || !isRecord(resultValue)) return [issue("MALFORMED_RESULT", "request and result must be objects")];
  const request = requestValue as unknown as PublicationRequest;
  const result = resultValue as unknown as PublicationResult;
  for (const field of ["publicationId", "runId", "mode"] as const) {
    if (request[field] !== result[field]) errors.push(issue("RESULT_REQUEST_MISMATCH", `${field} must match the authorized request`));
  }
  if (request.repository.owner !== result.repository.owner || request.repository.name !== result.repository.name) {
    errors.push(issue("RESULT_REQUEST_MISMATCH", "returned repository must match the authorized request"));
  }
  if (result.branch && result.branch.ref !== request.headRef) {
    errors.push(issue("RESULT_BRANCH_MISMATCH", "returned branch ref must match the authorized request"));
  }
  if (result.pullRequest) {
    if (!isPullRequestUrlForRepository(result.pullRequest.url, request.repository, result.pullRequest.number)) {
      errors.push(issue("RESULT_PULL_REQUEST_MISMATCH", "pull request URL must match the authorized repository"));
    }
  }
  if (request.mode === "pr" && result.outcome === "pr_published" && result.pullRequest?.state !== "open") {
    errors.push(issue("MALFORMED_RESULT", "PR publication is complete only with a confirmed open pull request"));
  }
  return errors;
}

function isPullRequestUrlForRepository(value: string, repository: PublicationRequest["repository"], number: number): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com"
      && url.pathname.toLowerCase() === `/${repository.owner}/${repository.name}/pull/${number}`.toLowerCase()
      && !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}
