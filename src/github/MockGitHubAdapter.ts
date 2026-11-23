import type { PublicationRequest, Repository } from "../contracts/types.js";
import { PublicationFailure } from "../errors/publication-error.js";
import { utf8 } from "../contracts/integrity.js";
import { repositoryKey } from "./repository-key.js";
import { validateGitObjectPath } from "./git-paths.js";
import { gitBlobSha, gitCommitSha } from "./git-objects.js";
import type { GitHubAdapter } from "./GitHubAdapter.js";
import { mockFaultFailure, skipMockFaultCall, type MockFault } from "./mock-faults.js";
import {
  assertNoPathCollisions,
  buildMockTree,
  flattenMockTree,
  MOCK_BASE_FILES,
  mockCommitContent,
  mockObjectExists,
  normalizeRef,
  refName,
  type MockRepositoryState,
} from "./mock-github-state.js";
import type {
  CreateCommitInput,
  CreatePullRequestInput,
  GitCommit,
  GitHubOperation,
  GitTreeEntry,
  GitTreeUpdate,
  PullRequestRecord,
  RepositoryIdentity,
} from "./types.js";

export type { MockFault } from "./mock-faults.js";

export class MockGitHubAdapter implements GitHubAdapter {
  readonly operations: GitHubOperation[] = [];
  readonly #repositories = new Map<string, MockRepositoryState>();
  readonly #faults = new Map<GitHubOperation, MockFault[]>();
  #nextPullRequestNumber = 1;

  injectFault(operation: GitHubOperation, fault: MockFault): void {
    const list = this.#faults.get(operation) ?? [];
    list.push({ ...fault, times: fault.times ?? 1 });
    this.#faults.set(operation, list);
  }

  reset(): void {
    this.operations.length = 0;
    this.#repositories.clear();
    this.#faults.clear();
    this.#nextPullRequestNumber = 1;
  }

  async seedForRequest(request: PublicationRequest): Promise<void> {
    if (this.#repositories.has(repositoryKey(request.repository))) return;
    const blobs = new Map<string, Uint8Array>();
    const leaves: GitTreeEntry[] = [];
    for (const file of MOCK_BASE_FILES) {
      const bytes = utf8(file.content);
      const sha = await gitBlobSha(bytes);
      blobs.set(sha, bytes);
      leaves.push({ path: file.path, mode: "100644", type: "blob", sha });
    }
    const trees = new Map<string, GitTreeEntry[]>();
    const rootTreeSha = await buildMockTree(trees, leaves);
    const baseCommitContent = mockCommitContent(rootTreeSha, undefined, "mock base commit");
    const baseSha = await gitCommitSha(baseCommitContent);
    if (baseSha !== request.baseSha) throw new PublicationFailure("BASE_TREE_CONFLICT");
    const baseCommit: GitCommit = {
      sha: baseSha,
      treeSha: rootTreeSha,
      message: "mock base commit",
    };
    this.#repositories.set(repositoryKey(request.repository), {
      identity: {
        ...request.repository,
        fullName: `${request.repository.owner}/${request.repository.name}`,
        id: 1,
        installationId: 1,
      },
      refs: new Map([[refName(request.baseRef), baseSha]]),
      commits: new Map([[baseSha, baseCommit]]),
      trees,
      blobs,
      pullRequests: [],
    });
  }

  async moveBase(repository: Repository, baseRef: string): Promise<string> {
    const state = this.#repo(repository);
    const current = state.refs.get(refName(baseRef));
    if (!current) throw new PublicationFailure("REPOSITORY_NOT_ALLOWED");
    const currentCommit = state.commits.get(current);
    if (!currentCommit) throw new PublicationFailure("INTERNAL_ERROR");
    const message = `mock moved base ${baseRef}`;
    const sha = await gitCommitSha(mockCommitContent(currentCommit.treeSha, current, message));
    state.commits.set(sha, { sha, treeSha: currentCommit.treeSha, parentSha: current, message });
    state.refs.set(refName(baseRef), sha);
    return sha;
  }

  async addExistingBranch(repository: Repository, ref: string, sha: string): Promise<void> {
    const state = this.#repo(repository);
    if (!state.commits.has(sha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    const key = refName(ref);
    if (state.refs.has(key)) throw new PublicationFailure("BRANCH_CONFLICT");
    state.refs.set(key, sha);
  }

  setPullRequestState(repository: Repository, number: number, stateValue: PullRequestRecord["state"]): void {
    const state = this.#repo(repository);
    const pullRequest = state.pullRequests.find((item) => item.number === number);
    if (pullRequest) pullRequest.state = stateValue;
  }

  setPullRequestMetadata(repository: Repository, number: number, metadata: { title: string; body: string }): void {
    const state = this.#repo(repository);
    const pullRequest = state.pullRequests.find((item) => item.number === number);
    if (pullRequest) {
      pullRequest.title = metadata.title;
      pullRequest.body = metadata.body;
    }
  }

  async setBaseTreeEntry(repository: Repository, treeSha: string, entry: GitTreeEntry): Promise<string> {
    const state = this.#repo(repository);
    const nextTreeSha = await this.#treeWithEntry(state, treeSha, entry);
    const replacements = await this.#commitsWithTree(state, treeSha, nextTreeSha);
    this.#replaceCommits(state, replacements);
    return [...replacements.values()][0]?.sha ?? "";
  }

  async #treeWithEntry(state: MockRepositoryState, treeSha: string, entry: GitTreeEntry): Promise<string> {
    if (!state.trees.has(treeSha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    if (!mockObjectExists(state, entry)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    const flattened = await flattenMockTree(state, treeSha);
    const leaves = flattened.filter((item) => item.type !== "tree" && item.path !== entry.path);
    leaves.push({ ...entry });
    return buildMockTree(state.trees, leaves);
  }

  async #commitsWithTree(state: MockRepositoryState, treeSha: string, nextTreeSha: string): Promise<Map<string, GitCommit>> {
    const replacements = new Map<string, GitCommit>();
    for (const commit of state.commits.values()) {
      if (commit.treeSha !== treeSha) continue;
      const sha = await gitCommitSha(mockCommitContent(nextTreeSha, commit.parentSha, commit.message));
      replacements.set(commit.sha, { ...commit, sha, treeSha: nextTreeSha });
    }
    return replacements;
  }

  #replaceCommits(state: MockRepositoryState, replacements: Map<string, GitCommit>): void {
    for (const [oldSha, replacement] of replacements) {
      state.commits.delete(oldSha);
      state.commits.set(replacement.sha, replacement);
      for (const [ref, currentSha] of state.refs) {
        if (currentSha === oldSha) state.refs.set(ref, replacement.sha);
      }
    }
  }

  async setBaseBlob(repository: Repository, sha: string, content: Uint8Array): Promise<void> {
    if (await gitBlobSha(content) !== sha) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    this.#repo(repository).blobs.set(sha, content.slice());
  }

  count(operation: GitHubOperation): number {
    return this.operations.filter((item) => item === operation).length;
  }

  async resolveRepository(repository: Repository, _operation: "branch" | "pr"): Promise<RepositoryIdentity> {
    this.#begin("resolveRepository");
    const result = this.#repo(repository).identity;
    this.#finish("resolveRepository");
    return { ...result };
  }

  async readRef(repository: Repository, ref: string): Promise<string | undefined> {
    this.#begin("readRef");
    const result = this.#repo(repository).refs.get(refName(ref));
    this.#finish("readRef");
    return result;
  }

  async readCommit(repository: Repository, sha: string): Promise<GitCommit | undefined> {
    this.#begin("readCommit");
    const value = this.#repo(repository).commits.get(sha);
    this.#finish("readCommit");
    return value ? { ...value } : undefined;
  }

  async readTree(repository: Repository, treeSha: string): Promise<GitTreeEntry[]> {
    this.#begin("readTree");
    const state = this.#repo(repository);
    if (!state.trees.has(treeSha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    const result = await flattenMockTree(state, treeSha);
    this.#finish("readTree");
    return result;
  }

  async readBlob(repository: Repository, sha: string): Promise<Uint8Array | undefined> {
    this.#begin("readBlob");
    const blob = this.#repo(repository).blobs.get(sha);
    this.#finish("readBlob");
    return blob?.slice();
  }

  async createBlob(repository: Repository, content: Uint8Array): Promise<string> {
    this.#begin("createBlob");
    const state = this.#repo(repository);
    const sha = await gitBlobSha(content);
    state.blobs.set(sha, content.slice());
    this.#finish("createBlob");
    return sha;
  }

  async createTree(repository: Repository, baseTreeSha: string, updates: GitTreeUpdate[]): Promise<string> {
    this.#begin("createTree");
    const state = this.#repo(repository);
    if (!state.trees.has(baseTreeSha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    const flattened = await flattenMockTree(state, baseTreeSha);
    const leaves = new Map(flattened.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, { ...entry }]));
    for (const update of updates) {
      validateGitObjectPath(update.path);
      if (update.mode !== "100644" || update.type !== "blob") throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
      const current = leaves.get(update.path);
      if (update.sha === null) {
        if (!current) throw new PublicationFailure("BASE_TREE_CONFLICT");
        leaves.delete(update.path);
      } else {
        if (!state.blobs.has(update.sha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
        leaves.set(update.path, { path: update.path, mode: update.mode, type: update.type, sha: update.sha });
      }
    }
    assertNoPathCollisions([...leaves.keys()]);
    const sha = await buildMockTree(state.trees, [...leaves.values()]);
    this.#finish("createTree");
    return sha;
  }

  async createCommit(repository: Repository, input: CreateCommitInput): Promise<GitCommit> {
    this.#begin("createCommit");
    const state = this.#repo(repository);
    if (!state.trees.has(input.treeSha) || !state.commits.has(input.parentSha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    const sha = await gitCommitSha(mockCommitContent(input.treeSha, input.parentSha, input.message));
    const commit: GitCommit = { sha, treeSha: input.treeSha, parentSha: input.parentSha, message: input.message };
    state.commits.set(sha, commit);
    this.#finish("createCommit");
    return { ...commit };
  }

  async createRef(repository: Repository, ref: string, sha: string): Promise<void> {
    this.#begin("createRef");
    const state = this.#repo(repository);
    const key = refName(ref);
    if (state.refs.has(key)) throw new PublicationFailure("BRANCH_CONFLICT");
    if (!state.commits.has(sha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    state.refs.set(key, sha);
    this.#finish("createRef");
  }

  async listPullRequests(repository: Repository, headRef: string, baseRef: string): Promise<PullRequestRecord[]> {
    this.#begin("listPullRequests");
    const result = this.#repo(repository).pullRequests
      .filter((item) => item.headRef === normalizeRef(headRef) && item.baseRef === normalizeRef(baseRef))
      .map((item) => ({ ...item, headRepository: { ...item.headRepository }, baseRepository: { ...item.baseRepository } }));
    this.#finish("listPullRequests");
    return result;
  }

  async createPullRequest(repository: Repository, input: CreatePullRequestInput): Promise<PullRequestRecord> {
    this.#begin("createPullRequest");
    const state = this.#repo(repository);
    const headRef = normalizeRef(input.headRef);
    const baseRef = normalizeRef(input.baseRef);
    if (state.pullRequests.some((item) => item.headRef === headRef && item.baseRef === baseRef)) {
      throw new PublicationFailure("PULL_REQUEST_CONFLICT");
    }
    if (!state.refs.has(refName(headRef)) || !state.refs.has(refName(baseRef))) {
      throw new PublicationFailure("PULL_REQUEST_CONFLICT");
    }
    const number = this.#nextPullRequestNumber++;
    const record: PullRequestRecord = {
      number,
      url: `https://github.com/${repository.owner}/${repository.name}/pull/${number}`,
      state: "open",
      headRef,
      baseRef,
      headRepository: { ...repository },
      baseRepository: { ...repository },
      title: input.title,
      body: input.body,
    };
    state.pullRequests.push(record);
    this.#finish("createPullRequest");
    return { ...record, headRepository: { ...record.headRepository }, baseRepository: { ...record.baseRepository } };
  }

  #repo(repository: Repository): MockRepositoryState {
    const value = this.#repositories.get(repositoryKey(repository));
    if (!value) throw new PublicationFailure("REPOSITORY_NOT_ALLOWED");
    return value;
  }

  #begin(operation: GitHubOperation): void {
    this.operations.push(operation);
    this.#throwFault(operation, false);
  }

  #finish(operation: GitHubOperation): void {
    this.#throwFault(operation, true);
  }

  #throwFault(operation: GitHubOperation, afterMutation: boolean): void {
    const faults = this.#faults.get(operation);
    const fault = faults?.[0];
    if (!fault || Boolean(fault.afterMutation) !== afterMutation) return;
    if (skipMockFaultCall(fault)) return;
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) faults?.shift();
    throw mockFaultFailure(operation, fault);
  }
}
