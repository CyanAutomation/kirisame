import { canonicalBase64ToBytes, sha256Hex, utf8 } from "../contracts/integrity.js";
import { canonicalizeJson } from "../contracts/canonicalize.js";
import { validateContract, validateResultAgainstRequest } from "../contracts/validate.js";
import type { FileChange, PublicationRequest, PublicationResult } from "../contracts/types.js";
import { asPublicationFailure, PublicationFailure } from "../errors/publication-error.js";
import type { GitHubAdapter } from "../github/GitHubAdapter.js";
import { gitBlobSha } from "../github/git-objects.js";
import type { GitCommit, GitTreeEntry, GitTreeUpdate, PullRequestRecord } from "../github/types.js";
import type { PublicationPolicy } from "./policy.js";
import { isAttributesPath, rejectLfsGovernedChanges } from "./git-attributes.js";

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
    if (!requestValidation.valid) {
      const code = requestValidation.errors.find((item) => item.code === "ARTIFACT_DIGEST_MISMATCH")
        ? "ARTIFACT_DIGEST_MISMATCH"
        : requestValidation.errors.find((item) => item.code === "ARTIFACT_PROVENANCE_MISMATCH")
          ? "ARTIFACT_PROVENANCE_MISMATCH"
          : requestValidation.errors.some((item) => item.code === "UNSAFE_HEAD_REF")
            ? "UNAUTHORIZED_CALLER"
            : requestValidation.errors.some((item) => item.code === "UNSUPPORTED_GIT_ATTRIBUTES_CHANGE")
              ? "UNSUPPORTED_GIT_OBJECT"
            : "ARTIFACT_INVALID";
      throw new PublicationFailure(code);
    }
    let confirmedBranch: PublicationResult["branch"];
    try {
      await this.#policy.authorize(request);
      await this.#adapter.resolveRepository(request.repository, request.mode);
      const branchRef = `refs/heads/${request.headRef}`;
      const existingSha = await this.#adapter.readRef(request.repository, branchRef);
      let commit: GitCommit;
      if (existingSha) {
        commit = await this.#verifyBranch(request, existingSha);
        confirmedBranch = { ref: request.headRef, commitSha: commit.sha, reused: true };
      } else {
        const created = await this.#createBranch(request);
        commit = created.commit;
        confirmedBranch = { ref: request.headRef, commitSha: commit.sha, reused: created.reused };
      }

      if (request.mode === "branch") {
        return this.#checkedSuccess(request, {
          contractVersion: "1",
          publicationId: request.publicationId,
          runId: request.runId,
          repository: { ...request.repository },
          mode: "branch",
          outcome: "branch_published",
          retryable: false,
          reconciliation: "branch_confirmed",
          branch: confirmedBranch,
        });
      }
      return await this.#reconcilePullRequest(request, confirmedBranch);
    } catch (error) {
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
        ...(confirmedBranch ? { branch: confirmedBranch } : {}),
        error: failure.toContractError(),
      };
      if (confirmedBranch && request.mode === "pr" && retryable) result.reconciliation = "branch_confirmed";
      const validation = await validateResultAgainstRequest(request, result);
      if (validation.length > 0) return this.#internalFailure(request);
      return result;
    }
  }

  async #createBranch(request: PublicationRequest): Promise<{ commit: GitCommit; reused: boolean }> {
    const baseRefSha = await this.#adapter.readRef(request.repository, request.baseRef);
    if (baseRefSha !== request.baseSha) throw new PublicationFailure("BASE_MOVED");
    const baseCommit = await this.#requiredCommit(request, request.baseSha);
    const baseTree = await this.#adapter.readTree(request.repository, baseCommit.treeSha);
    const expected = await this.#applyArtifact(request, baseTree);
    this.#rejectNoOp(baseTree, expected);

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

    const treeSha = await this.#adapter.createTree(request.repository, baseCommit.treeSha, updates);
    const marker = await this.#publicationMarker(request);
    const commit = await this.#adapter.createCommit(request.repository, {
      treeSha,
      parentSha: request.baseSha,
      message: `${request.title ?? "Kirisame branch publication"}\n\n${marker}`,
    });
    await this.#compareExpectedTree(request, commit.treeSha, expected);

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
    const expected = await this.#applyArtifact(request, baseTree);
    this.#rejectNoOp(baseTree, expected);
    await this.#compareExpectedEntries(headTree, expected);
    return commit;
  }

  async #reconcilePullRequest(request: PublicationRequest, branch: NonNullable<PublicationResult["branch"]>): Promise<PublicationResult> {
    const existing = await this.#adapter.listPullRequests(request.repository, request.headRef, request.baseRef);
    if (existing.length > 1) throw new PublicationFailure("PULL_REQUEST_CONFLICT");
    if (existing.length === 1) {
      await this.#verifyPullRequest(existing[0]!, request);
      return this.#prSuccess(request, branch, existing[0]!);
    }

    // Existing branches without a PR are only completed against the original pinned base.
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
      const afterMutationFailure = asPublicationFailure(error);
      const reconciled = await this.#adapter.listPullRequests(request.repository, request.headRef, request.baseRef);
      if (reconciled.length === 1) {
        await this.#verifyPullRequest(reconciled[0]!, request);
        return this.#prSuccess(request, { ...branch, reused: true }, reconciled[0]!);
      }
      if (reconciled.length > 1) throw new PublicationFailure("PULL_REQUEST_CONFLICT");
      if (afterMutationFailure.code === "PULL_REQUEST_CONFLICT") throw afterMutationFailure;
      if (afterMutationFailure.classification === "retryable") throw new PublicationFailure("RECONCILIATION_REQUIRED", {
        ...(afterMutationFailure.retryAfterSeconds !== undefined ? { retryAfterSeconds: afterMutationFailure.retryAfterSeconds } : {}),
      });
      throw afterMutationFailure;
    }
  }

  async #applyArtifact(request: PublicationRequest, baseTree: GitTreeEntry[]): Promise<GitTreeEntry[]> {
    if (request.artifact.files.some((file) => isAttributesPath(file.path))) {
      throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    }
    await rejectLfsGovernedChanges(
      baseTree,
      request.artifact.files.map((file) => file.path),
      (sha) => this.#readVerifiedBlob(request, sha),
    );
    const leafEntries = baseTree.filter((entry) => entry.type !== "tree");
    const expected = new Map(leafEntries.map((entry) => [entry.path, { ...entry }]));
    for (const change of request.artifact.files) {
      const exact = baseTree.find((entry) => entry.path === change.path);
      const ancestors = leafEntries.filter((entry) => change.path.startsWith(`${entry.path}/`));
      const descendants = leafEntries.filter((entry) => entry.path.startsWith(`${change.path}/`));
      if (ancestors.length > 0 || descendants.length > 0) throw new PublicationFailure("BASE_TREE_CONFLICT");

      if (change.operation === "add") {
        if (exact) throw new PublicationFailure(exact.type === "blob" && exact.mode !== "100644" ? "UNSUPPORTED_GIT_OBJECT" : "BASE_TREE_CONFLICT");
        expected.set(change.path, { path: change.path, mode: "100644", type: "blob", sha: await this.#contentBlobSha(change) });
        continue;
      }

      if (!exact) throw new PublicationFailure("BASE_TREE_CONFLICT");
      if (exact.type === "tree" || exact.mode === "040000") throw new PublicationFailure("BASE_TREE_CONFLICT");
      if (exact.type !== "blob" || exact.mode !== "100644") throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
      if (exact.sha !== change.baseBlobSha) throw new PublicationFailure("BASE_TREE_CONFLICT");
      const prior = await this.#readVerifiedBlob(request, exact.sha);
      if (!prior) throw new PublicationFailure("GITHUB_UNAVAILABLE");
      this.#rejectUnsupportedPriorContent(prior);

      if (change.operation === "delete") expected.delete(change.path);
      else expected.set(change.path, { path: change.path, mode: "100644", type: "blob", sha: await this.#contentBlobSha(change) });
    }
    return [...expected.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }

  async #compareExpectedTree(request: PublicationRequest, treeSha: string, expected: GitTreeEntry[]): Promise<void> {
    const actual = await this.#adapter.readTree(request.repository, treeSha);
    await this.#compareExpectedEntries(actual, expected);
  }

  async #compareExpectedEntries(actual: GitTreeEntry[], expected: GitTreeEntry[]): Promise<void> {
    const normalize = (entries: GitTreeEntry[]) => entries.filter((entry) => entry.type !== "tree")
      .map((entry) => `${entry.path}\0${entry.mode}\0${entry.type}\0${entry.type === "tree" ? "" : entry.sha}`)
      .sort();
    const actualValues = normalize(actual);
    const expectedValues = normalize(expected);
    if (actualValues.length !== expectedValues.length || actualValues.some((value, index) => value !== expectedValues[index])) {
      throw new PublicationFailure("BRANCH_CONFLICT");
    }
  }

  async #requiredCommit(request: PublicationRequest, sha: string): Promise<GitCommit> {
    const commit = await this.#adapter.readCommit(request.repository, sha);
    if (!commit) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    return commit;
  }

  async #contentBlobSha(change: Exclude<FileChange, { operation: "delete" }>): Promise<string> {
    const bytes = canonicalBase64ToBytes(change.content.data);
    if (!bytes) throw new PublicationFailure("ARTIFACT_INVALID");
    return gitBlobSha(bytes);
  }

  async #readVerifiedBlob(request: PublicationRequest, sha: string): Promise<Uint8Array | undefined> {
    const content = await this.#adapter.readBlob(request.repository, sha);
    if (!content) return undefined;
    if (await gitBlobSha(content) !== sha) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    return content;
  }

  #rejectNoOp(baseTree: GitTreeEntry[], expected: GitTreeEntry[]): void {
    const fingerprint = (entries: GitTreeEntry[]) => entries
      .filter((entry) => entry.type !== "tree")
      .map((entry) => `${entry.path}\0${entry.mode}\0${entry.type}\0${entry.sha}`)
      .sort();
    const before = fingerprint(baseTree);
    const after = fingerprint(expected);
    if (before.length === after.length && before.every((entry, index) => entry === after[index])) {
      throw new PublicationFailure("NO_CHANGES");
    }
  }

  #rejectUnsupportedPriorContent(bytes: Uint8Array): void {
    if (new TextDecoder("utf-8", { fatal: false }).decode(bytes).startsWith("version https://git-lfs.github.com/spec/v1\n")) {
      throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new TypeError("binary");
    } catch {
      throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    }
  }

  async #verifyPullRequest(pullRequest: PullRequestRecord, request: PublicationRequest): Promise<void> {
    const marker = await this.#publicationMarker(request);
    if (pullRequest.headRef !== request.headRef || pullRequest.baseRef !== request.baseRef
      || pullRequest.headRepository.owner.toLowerCase() !== request.repository.owner.toLowerCase()
      || pullRequest.headRepository.name.toLowerCase() !== request.repository.name.toLowerCase()
      || pullRequest.baseRepository.owner.toLowerCase() !== request.repository.owner.toLowerCase()
      || pullRequest.baseRepository.name.toLowerCase() !== request.repository.name.toLowerCase()
      || !isExpectedPullRequestUrl(pullRequest.url, request.repository, pullRequest.number)
      || !hasExactPublicationMarker(pullRequest.body, marker)
      || pullRequest.state !== "open") {
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
    if (errors.length > 0) return this.#internalFailure(request);
    return result;
  }

  #internalFailure(request: PublicationRequest): PublicationResult {
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
