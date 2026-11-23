import { canonicalBase64ToBytes, sha256Hex, utf8 } from "../contracts/integrity.js";
import { canonicalizeJson } from "../contracts/canonicalize.js";
import { validateContract, validateResultAgainstRequest } from "../contracts/validate.js";
import type { PublicationRequest, PublicationResult, PublicationErrorCode, ValidationIssue } from "../contracts/types.js";
import { asPublicationFailure, PublicationFailure } from "../errors/publication-error.js";
import type { GitHubAdapter } from "../github/GitHubAdapter.js";
import { gitBlobSha } from "../github/git-objects.js";
import type { GitCommit, GitTreeEntry, GitTreeUpdate, PullRequestRecord } from "../github/types.js";
import type { PublicationPolicy } from "./policy.js";
import {
  applyArtifactToTree,
  compareExpectedEntries,
  compareExpectedTree,
  rejectNoOp,
} from "./artifact-tree.js";

const MARKER = "Kirisame-Publication";

export class PublicationService {
  readonly #adapter: GitHubAdapter;
  readonly #policy: PublicationPolicy;

  constructor(adapter: GitHubAdapter, policy: PublicationPolicy) {
    this.#adapter = adapter;
    this.#policy = policy;
  }

  async publish(request: PublicationRequest): Promise<PublicationResult> {
    const requestValidation = await validateContract("publication-request", request);
    if (!requestValidation.valid) throw new PublicationFailure(requestFailureCode(requestValidation.errors));
    let confirmedBranch: PublicationResult["branch"];
    try {
      confirmedBranch = await this.#publishBranch(request);
      return request.mode === "branch"
        ? this.#branchSuccess(request, confirmedBranch)
        : await this.#reconcilePullRequest(request, confirmedBranch);
    } catch (error) {
      return failureResult(request, error, confirmedBranch);
    }
  }

  async #publishBranch(request: PublicationRequest): Promise<NonNullable<PublicationResult["branch"]>> {
    await this.#policy.authorize(request);
    await this.#adapter.resolveRepository(request.repository, request.mode);
    const existingSha = await this.#adapter.readRef(request.repository, `refs/heads/${request.headRef}`);
    if (existingSha) {
      const commit = await this.#verifyBranch(request, existingSha);
      return { ref: request.headRef, commitSha: commit.sha, reused: true };
    }
    const created = await this.#createBranch(request);
    return { ref: request.headRef, commitSha: created.commit.sha, reused: created.reused };
  }

  #branchSuccess(request: PublicationRequest, branch: NonNullable<PublicationResult["branch"]>): Promise<PublicationResult> {
    return this.#checkedSuccess(request, {
      contractVersion: "1",
      publicationId: request.publicationId,
      runId: request.runId,
      repository: { ...request.repository },
      mode: "branch",
      outcome: "branch_published",
      retryable: false,
      reconciliation: "branch_confirmed",
      branch,
    });
  }

  async #createBranch(request: PublicationRequest): Promise<{ commit: GitCommit; reused: boolean }> {
    const baseRefSha = await this.#adapter.readRef(request.repository, request.baseRef);
    if (baseRefSha !== request.baseSha) throw new PublicationFailure("BASE_MOVED");
    const baseCommit = await this.#requiredCommit(request, request.baseSha);
    const baseTree = await this.#adapter.readTree(request.repository, baseCommit.treeSha);
    const expected = await applyArtifactToTree(this.#adapter, request, baseTree);
    rejectNoOp(baseTree, expected);
    const updates = await this.#branchTreeUpdates(request);
    const commit = await this.#createBranchCommit(request, baseCommit, updates, expected);
    return this.#createBranchRef(request, commit);
  }

  async #branchTreeUpdates(request: PublicationRequest): Promise<GitTreeUpdate[]> {
    const updates: GitTreeUpdate[] = [];
    for (const file of request.artifact.files) {
      if (file.operation === "delete") {
        updates.push({ path: file.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const bytes = canonicalBase64ToBytes(file.content.data);
      if (!bytes) throw new PublicationFailure("ARTIFACT_INVALID");
      const expectedSha = await gitBlobSha(bytes);
      const createdSha = await this.#adapter.createBlob(request.repository, bytes);
      if (createdSha !== expectedSha) throw new PublicationFailure("INTERNAL_ERROR");
      updates.push({ path: file.path, mode: "100644", type: "blob", sha: createdSha });
    }
    return updates;
  }

  async #createBranchCommit(
    request: PublicationRequest,
    baseCommit: GitCommit,
    updates: GitTreeUpdate[],
    expected: GitTreeEntry[],
  ): Promise<GitCommit> {
    const treeSha = await this.#adapter.createTree(request.repository, baseCommit.treeSha, updates);
    const marker = await this.#publicationMarker(request);
    const commit = await this.#adapter.createCommit(request.repository, {
      treeSha,
      parentSha: request.baseSha,
      message: `${request.title ?? "Kirisame branch publication"}\n\n${marker}`,
    });
    await compareExpectedTree(this.#adapter, request, commit.treeSha, expected);
    return commit;
  }

  async #createBranchRef(request: PublicationRequest, commit: GitCommit): Promise<{ commit: GitCommit; reused: boolean }> {
    try {
      await this.#adapter.createRef(request.repository, request.headRef, commit.sha);
    } catch (error) {
      const headSha = await this.#adapter.readRef(request.repository, request.headRef);
      if (!headSha) throw error;
      return { commit: await this.#verifyBranch(request, headSha), reused: true };
    }
    const headSha = await this.#adapter.readRef(request.repository, request.headRef);
    if (!headSha) throw new PublicationFailure("RECONCILIATION_REQUIRED");
    return { commit: await this.#verifyBranch(request, headSha), reused: false };
  }

  async #verifyBranch(request: PublicationRequest, headSha: string): Promise<GitCommit> {
    const commit = await this.#requiredCommit(request, headSha);
    if (commit.parentSha !== request.baseSha || !(await this.#hasExpectedMarker(commit.message, request))) {
      throw new PublicationFailure("BRANCH_CONFLICT");
    }
    const baseCommit = await this.#requiredCommit(request, request.baseSha);
    const [baseTree, headTree] = await Promise.all([
      this.#adapter.readTree(request.repository, baseCommit.treeSha),
      this.#adapter.readTree(request.repository, commit.treeSha),
    ]);
    const expected = await applyArtifactToTree(this.#adapter, request, baseTree);
    rejectNoOp(baseTree, expected);
    compareExpectedEntries(headTree, expected);
    return commit;
  }

  async #reconcilePullRequest(request: PublicationRequest, branch: NonNullable<PublicationResult["branch"]>): Promise<PublicationResult> {
    const existing = await this.#adapter.listPullRequests(request.repository, request.headRef, request.baseRef);
    if (existing.length > 1) throw new PublicationFailure("PULL_REQUEST_CONFLICT");
    if (existing.length === 1) return this.#confirmExistingPullRequest(request, branch, existing[0]!);
    return this.#createPullRequest(request, branch);
  }

  async #confirmExistingPullRequest(
    request: PublicationRequest,
    branch: NonNullable<PublicationResult["branch"]>,
    pullRequest: PullRequestRecord,
  ): Promise<PublicationResult> {
    await this.#verifyPullRequest(pullRequest, request);
    return this.#prSuccess(request, branch, pullRequest);
  }

  async #createPullRequest(
    request: PublicationRequest,
    branch: NonNullable<PublicationResult["branch"]>,
  ): Promise<PublicationResult> {
    const currentBase = await this.#adapter.readRef(request.repository, request.baseRef);
    if (currentBase !== request.baseSha) throw new PublicationFailure("BASE_MOVED");
    const body = `${request.body ?? ""}${request.body ? "\n\n" : ""}${await this.#publicationMarker(request)}`;
    try {
      const pullRequest = await this.#adapter.createPullRequest(request.repository, {
        title: request.title!,
        body,
        headRef: request.headRef,
        baseRef: request.baseRef,
      });
      await this.#verifyPullRequest(pullRequest, request);
      return this.#prSuccess(request, branch, pullRequest);
    } catch (error) {
      return this.#recoverPullRequestCreation(request, branch, error);
    }
  }

  async #recoverPullRequestCreation(
    request: PublicationRequest,
    branch: NonNullable<PublicationResult["branch"]>,
    error: unknown,
  ): Promise<PublicationResult> {
    const failure = asPublicationFailure(error);
    const reconciled = await this.#adapter.listPullRequests(request.repository, request.headRef, request.baseRef);
    if (reconciled.length === 1) {
      await this.#verifyPullRequest(reconciled[0]!, request);
      return this.#prSuccess(request, { ...branch, reused: true }, reconciled[0]!);
    }
    if (reconciled.length > 1) throw new PublicationFailure("PULL_REQUEST_CONFLICT");
    if (failure.code === "PULL_REQUEST_CONFLICT") throw failure;
    if (failure.classification === "retryable") {
      throw new PublicationFailure("RECONCILIATION_REQUIRED", {
        ...(failure.retryAfterSeconds !== undefined ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
      });
    }
    throw failure;
  }

  async #requiredCommit(request: PublicationRequest, sha: string): Promise<GitCommit> {
    const commit = await this.#adapter.readCommit(request.repository, sha);
    if (!commit) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    return commit;
  }

  async #verifyPullRequest(pullRequest: PullRequestRecord, request: PublicationRequest): Promise<void> {
    const marker = await this.#publicationMarker(request);
    if (!isExpectedPullRequest(pullRequest, request, marker)) {
      throw new PublicationFailure("PULL_REQUEST_CONFLICT");
    }
  }

  #prSuccess(request: PublicationRequest, branch: NonNullable<PublicationResult["branch"]>, pullRequest: PullRequestRecord): Promise<PublicationResult> {
    return this.#checkedSuccess(request, {
      contractVersion: "1",
      publicationId: request.publicationId,
      runId: request.runId,
      repository: { ...request.repository },
      mode: "pr",
      outcome: "pr_published",
      retryable: false,
      reconciliation: "pull_request_confirmed",
      branch,
      pullRequest: { number: pullRequest.number, url: pullRequest.url, state: pullRequest.state },
    });
  }

  async #checkedSuccess(request: PublicationRequest, result: PublicationResult): Promise<PublicationResult> {
    const errors = await validateResultAgainstRequest(request, result);
    if (errors.length > 0) return internalFailure(request);
    return result;
  }

  async #publicationMarker(request: PublicationRequest): Promise<string> {
    const canonical = canonicalizeJson(request);
    if (canonical === undefined) throw new PublicationFailure("ARTIFACT_INVALID");
    const requestDigest = await sha256Hex(utf8(canonical));
    return `${MARKER}: ${request.publicationId}\nKirisame-Run: ${request.runId}\nKirisame-Artifact: ${request.artifactDigest}\nKirisame-Request: sha256:${requestDigest}`;
  }

  async #hasExpectedMarker(message: string, request: PublicationRequest): Promise<boolean> {
    const title = request.title ?? "Kirisame branch publication";
    return message === `${title}\n\n${await this.#publicationMarker(request)}`;
  }
}

function isExpectedPullRequest(
  pullRequest: PullRequestRecord,
  request: PublicationRequest,
  marker: string,
): boolean {
  return pullRequest.headRef === request.headRef
    && pullRequest.baseRef === request.baseRef
    && isExpectedRepository(pullRequest.headRepository, request.repository)
    && isExpectedRepository(pullRequest.baseRepository, request.repository)
    && isExpectedPullRequestUrl(pullRequest.url, request.repository, pullRequest.number)
    && hasExactPublicationMarker(pullRequest.body, marker)
    && pullRequest.state === "open";
}

function isExpectedRepository(actual: PublicationRequest["repository"], expected: PublicationRequest["repository"]): boolean {
  return actual.owner.toLowerCase() === expected.owner.toLowerCase()
    && actual.name.toLowerCase() === expected.name.toLowerCase();
}

function requestFailureCode(errors: ValidationIssue[]): PublicationErrorCode {
  if (errors.some((item) => item.code === "ARTIFACT_DIGEST_MISMATCH")) return "ARTIFACT_DIGEST_MISMATCH";
  if (errors.some((item) => item.code === "ARTIFACT_PROVENANCE_MISMATCH")) return "ARTIFACT_PROVENANCE_MISMATCH";
  if (errors.some((item) => item.code === "UNSAFE_HEAD_REF")) return "UNAUTHORIZED_CALLER";
  if (errors.some((item) => item.code === "UNSUPPORTED_GIT_ATTRIBUTES_CHANGE")) return "UNSUPPORTED_GIT_OBJECT";
  return "ARTIFACT_INVALID";
}

async function failureResult(
  request: PublicationRequest,
  error: unknown,
  branch: PublicationResult["branch"],
): Promise<PublicationResult> {
  const failure = asPublicationFailure(error);
  const retryable = failure.classification === "retryable";
  const result: PublicationResult = {
    contractVersion: "1",
    publicationId: request.publicationId,
    runId: request.runId,
    repository: { ...request.repository },
    mode: request.mode,
    outcome: retryable ? "retryable_failure" : "blocked",
    retryable,
    reconciliation: failure.classification === "conflict" ? "conflict" : retryable ? "unknown" : "not_needed",
    ...(branch ? { branch } : {}),
    error: failure.toContractError(),
  };
  if (branch && request.mode === "pr" && retryable) result.reconciliation = "branch_confirmed";
  const validation = await validateResultAgainstRequest(request, result);
  return validation.length > 0 ? internalFailure(request) : result;
}

function internalFailure(request: PublicationRequest): PublicationResult {
  return {
    contractVersion: "1",
    publicationId: request.publicationId,
    runId: request.runId,
    repository: { ...request.repository },
    mode: request.mode,
    outcome: "blocked",
    retryable: false,
    reconciliation: "unknown",
    error: new PublicationFailure("INTERNAL_ERROR").toContractError(),
  };
}

function isExpectedPullRequestUrl(value: string, repository: PublicationRequest["repository"], number: number): boolean {
  try {
    const url = new URL(value);
    const expectedPath = `/${repository.owner}/${repository.name}/pull/${number}`;
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.toLowerCase() === expectedPath.toLowerCase()
      && !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

function hasExactPublicationMarker(body: string, marker: string): boolean {
  const markerIndex = body.indexOf(marker);
  const markerPrefix = `${MARKER}:`;
  return markerIndex >= 0
    && body.indexOf(marker, markerIndex + marker.length) === -1
    && body.indexOf(markerPrefix) === markerIndex
    && body.indexOf(markerPrefix, markerIndex + markerPrefix.length) === -1;
}
