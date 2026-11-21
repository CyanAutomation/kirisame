import type { PublicationRequest, Repository } from "../contracts/types.js";
import { PublicationFailure } from "../errors/publication-error.js";
import { repositoryKey } from "../publication/policy.js";
import { sha1Hex, utf8 } from "../contracts/integrity.js";
import type { GitHubAdapter } from "./GitHubAdapter.js";
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

export interface MockFault {
  code: "GITHUB_AUTH_UNAVAILABLE" | "GITHUB_PERMISSION_DENIED" | "REPOSITORY_NOT_ALLOWED"
    | "BRANCH_CONFLICT" | "BASE_MOVED" | "GITHUB_RATE_LIMITED" | "GITHUB_TIMEOUT"
    | "GITHUB_UNAVAILABLE" | "PULL_REQUEST_CONFLICT";
  afterMutation?: boolean;
  retryAfterSeconds?: number;
  skip?: number;
  times?: number;
}

interface MockRepository {
  identity: RepositoryIdentity;
  refs: Map<string, string>;
  commits: Map<string, GitCommit>;
  trees: Map<string, GitTreeEntry[]>;
  blobs: Map<string, Uint8Array>;
  pullRequests: PullRequestRecord[];
}

const refName = (ref: string): string => `refs/heads/${ref.replace(/^refs\/heads\//, "")}`;

export class MockGitHubAdapter implements GitHubAdapter {
  readonly operations: GitHubOperation[] = [];
  readonly #repositories = new Map<string, MockRepository>();
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
    const files = new Map<string, GitTreeEntry>();
    for (const file of request.artifact.files) {
      if (file.operation !== "add") {
        files.set(file.path, { path: file.path, mode: "100644", type: "blob", sha: file.baseBlobSha });
      }
    }
    const tree = await this.#withDirectories([...files.values()]);
    const treeSha = await this.#treeSha(tree);
    const repository: MockRepository = {
      identity: { ...request.repository, fullName: `${request.repository.owner}/${request.repository.name}` },
      refs: new Map([[refName(request.baseRef), request.baseSha]]),
      commits: new Map([[request.baseSha, { sha: request.baseSha, treeSha, message: "mock base commit" }]]),
      trees: new Map([[treeSha, tree]]),
      blobs: new Map(request.artifact.files
        .filter((file) => file.operation !== "add")
        .map((file) => [file.baseBlobSha, utf8("mock base text\n")])),
      pullRequests: [],
    };
    this.#repositories.set(repositoryKey(request.repository), repository);
  }

  async moveBase(repository: Repository, baseRef: string): Promise<string> {
    const state = this.#repo(repository);
    const current = state.refs.get(refName(baseRef));
    if (!current) throw new PublicationFailure("REPOSITORY_NOT_ALLOWED");
    const currentCommit = state.commits.get(current);
    if (!currentCommit) throw new PublicationFailure("INTERNAL_ERROR");
    const sha = (await sha1Hex(utf8(`moved-base:${current}:${baseRef}`))).slice(0, 40);
    state.commits.set(sha, { sha, treeSha: currentCommit.treeSha, message: "moved base commit" });
    state.refs.set(refName(baseRef), sha);
    return sha;
  }

  async addExistingBranch(repository: Repository, ref: string, sha: string): Promise<void> {
    const state = this.#repo(repository);
    state.refs.set(refName(ref), sha);
  }

  setPullRequestState(repository: Repository, number: number, stateValue: PullRequestRecord["state"]): void {
    const state = this.#repo(repository);
    const pullRequest = state.pullRequests.find((item) => item.number === number);
    if (pullRequest) pullRequest.state = stateValue;
  }

  async setBaseTreeEntry(repository: Repository, treeSha: string, entry: GitTreeEntry): Promise<void> {
    const state = this.#repo(repository);
    const tree = state.trees.get(treeSha);
    if (!tree) throw new PublicationFailure("INTERNAL_ERROR");
    const leaves = tree.filter((item) => item.type !== "tree" && item.path !== entry.path);
    leaves.push({ ...entry });
    const nextTree = await this.#withDirectories(leaves);
    const nextSha = await this.#treeSha(nextTree);
    state.trees.set(nextSha, nextTree);
    for (const commit of state.commits.values()) {
      if (commit.treeSha === treeSha) commit.treeSha = nextSha;
    }
  }

  setBaseBlob(repository: Repository, sha: string, content: Uint8Array): void {
    this.#repo(repository).blobs.set(sha, content.slice());
  }

  count(operation: GitHubOperation): number {
    return this.operations.filter((item) => item === operation).length;
  }

  async resolveRepository(repository: Repository): Promise<RepositoryIdentity> {
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
    const tree = this.#repo(repository).trees.get(treeSha);
    if (!tree) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    this.#finish("readTree");
    return tree.map((entry) => ({ ...entry }));
  }

  async readBlob(repository: Repository, sha: string): Promise<Uint8Array | undefined> {
    this.#begin("readBlob");
    const blob = this.#repo(repository).blobs.get(sha);
    this.#finish("readBlob");
    return blob ? blob.slice() : undefined;
  }

  async createBlob(repository: Repository, content: Uint8Array): Promise<string> {
    this.#begin("createBlob");
    const header = utf8(`blob ${content.byteLength}\0`);
    const bytes = new Uint8Array(header.byteLength + content.byteLength);
    bytes.set(header);
    bytes.set(content, header.byteLength);
    const sha = await sha1Hex(bytes);
    this.#repo(repository).blobs.set(sha, content.slice());
    this.#finish("createBlob");
    return sha;
  }

  async createTree(repository: Repository, baseTreeSha: string, updates: GitTreeUpdate[]): Promise<string> {
    this.#begin("createTree");
    const state = this.#repo(repository);
    const baseTree = state.trees.get(baseTreeSha);
    if (!baseTree) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    const leaves = new Map(baseTree.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, { ...entry }]));
    for (const update of updates) {
      if (update.sha === null) leaves.delete(update.path);
      else leaves.set(update.path, { path: update.path, mode: update.mode, type: update.type, sha: update.sha });
    }
    const tree = await this.#withDirectories([...leaves.values()]);
    const sha = await this.#treeSha(tree);
    state.trees.set(sha, tree);
    this.#finish("createTree");
    return sha;
  }

  async createCommit(repository: Repository, input: CreateCommitInput): Promise<GitCommit> {
    this.#begin("createCommit");
    const state = this.#repo(repository);
    if (!state.trees.has(input.treeSha) || !state.commits.has(input.parentSha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    const sha = (await sha1Hex(utf8(JSON.stringify(input)))).slice(0, 40);
    const commit: GitCommit = { sha, treeSha: input.treeSha, parentSha: input.parentSha, message: input.message };
    state.commits.set(sha, commit);
    this.#finish("createCommit");
    return { ...commit };
  }

  async createRef(repository: Repository, ref: string, sha: string): Promise<void> {
    this.#begin("createRef");
    const state = this.#repo(repository);
    if (state.refs.has(refName(ref))) throw new PublicationFailure("BRANCH_CONFLICT");
    if (!state.commits.has(sha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    state.refs.set(refName(ref), sha);
    this.#finish("createRef");
  }

  async listPullRequests(repository: Repository, headRef: string, baseRef: string): Promise<PullRequestRecord[]> {
    this.#begin("listPullRequests");
    const result = this.#repo(repository).pullRequests
      .filter((item) => item.headRef === headRef && item.baseRef === baseRef)
      .map((item) => ({ ...item }));
    this.#finish("listPullRequests");
    return result;
  }

  async createPullRequest(repository: Repository, input: CreatePullRequestInput): Promise<PullRequestRecord> {
    this.#begin("createPullRequest");
    const state = this.#repo(repository);
    if (state.pullRequests.some((item) => item.headRef === input.headRef && item.baseRef === input.baseRef)) {
      throw new PublicationFailure("PULL_REQUEST_CONFLICT");
    }
    const number = this.#nextPullRequestNumber++;
    const record: PullRequestRecord = {
      number,
      url: `https://github.com/${repository.owner}/${repository.name}/pull/${number}`,
      state: "open",
      headRef: input.headRef,
      baseRef: input.baseRef,
      body: input.body,
    };
    state.pullRequests.push(record);
    this.#finish("createPullRequest");
    return { ...record };
  }

  #repo(repository: Repository): MockRepository {
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
    if (!fault || (fault.afterMutation ?? false) !== afterMutation) return;
    if ((fault.skip ?? 0) > 0) {
      fault.skip = (fault.skip ?? 0) - 1;
      return;
    }
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) faults?.shift();
    const options = fault.code === "GITHUB_RATE_LIMITED" ? { retryAfterSeconds: fault.retryAfterSeconds ?? 60 } : {};
    throw new PublicationFailure(fault.code, options);
  }

  async #withDirectories(files: GitTreeEntry[]): Promise<GitTreeEntry[]> {
    const directories = new Set<string>();
    for (const file of files) {
      const parts = file.path.split("/");
      for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
    }
    const entries = [...files.map((file) => ({ ...file }))];
    for (const directory of directories) {
      entries.push({ path: directory, mode: "040000", type: "tree", sha: (await sha1Hex(utf8(`tree:${directory}`))).slice(0, 40) });
    }
    return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }

  async #treeSha(entries: GitTreeEntry[]): Promise<string> {
    const canonical = entries.map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}`).join("\n");
    return (await sha1Hex(utf8(canonical))).slice(0, 40);
  }
}
