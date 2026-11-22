import type { PublicationRequest, Repository } from "../contracts/types.js";
import { PublicationFailure } from "../errors/publication-error.js";
import { repositoryKey } from "../publication/policy.js";
import { utf8 } from "../contracts/integrity.js";
import { gitBlobSha, gitCommitSha, gitTreeSha } from "./git-objects.js";
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
  code: "GITHUB_AUTH_UNAVAILABLE" | "GITHUB_AUTH_INVALID" | "GITHUB_PERMISSION_DENIED" | "REPOSITORY_NOT_ALLOWED"
    | "BRANCH_CONFLICT" | "BASE_MOVED" | "GITHUB_RATE_LIMITED" | "GITHUB_TIMEOUT"
    | "GITHUB_UNAVAILABLE" | "PULL_REQUEST_CONFLICT" | "TREE_TRUNCATED" | "API_CONFLICT"
    | "PR_LIST_INCOMPLETE" | "UNSUPPORTED_GIT_OBJECT";
  afterMutation?: boolean;
  retryAfterSeconds?: number;
  skip?: number;
  times?: number;
}

interface MockRepository {
  identity: RepositoryIdentity;
  refs: Map<string, string>;
  commits: Map<string, GitCommit>;
  /** Git tree objects contain immediate child entries, keyed by their canonical Git SHA. */
  trees: Map<string, GitTreeEntry[]>;
  blobs: Map<string, Uint8Array>;
  pullRequests: PullRequestRecord[];
}

interface TreeNode {
  entry?: GitTreeEntry;
  children: Map<string, TreeNode>;
}

const refName = (ref: string): string => `refs/heads/${normalizeRef(ref)}`;
const BASE_FILES = [
  { path: "docs/guide.md", content: "Current guide.\n" },
  { path: "obsolete.txt", content: "Obsolete file.\n" },
] as const;

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
    const blobs = new Map<string, Uint8Array>();
    const leaves: GitTreeEntry[] = [];
    for (const file of BASE_FILES) {
      const bytes = utf8(file.content);
      const sha = await gitBlobSha(bytes);
      blobs.set(sha, bytes);
      leaves.push({ path: file.path, mode: "100644", type: "blob", sha });
    }
    const trees = new Map<string, GitTreeEntry[]>();
    const rootTreeSha = await this.#buildTree(trees, leaves);
    const baseCommitContent = this.#commitContent(rootTreeSha, undefined, "mock base commit");
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
    const sha = await gitCommitSha(this.#commitContent(currentCommit.treeSha, current, message));
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

  async setBaseTreeEntry(repository: Repository, treeSha: string, entry: GitTreeEntry): Promise<string> {
    const state = this.#repo(repository);
    if (!state.trees.has(treeSha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    if (!this.#objectExists(state, entry)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    const flattened = await this.#flattenTree(state, treeSha);
    const leaves = flattened.filter((item) => item.type !== "tree" && item.path !== entry.path);
    leaves.push({ ...entry });
    const nextTreeSha = await this.#buildTree(state.trees, leaves);
    const replacements = new Map<string, GitCommit>();
    for (const commit of state.commits.values()) {
      if (commit.treeSha !== treeSha) continue;
      const sha = await gitCommitSha(this.#commitContent(nextTreeSha, commit.parentSha, commit.message));
      replacements.set(commit.sha, { ...commit, sha, treeSha: nextTreeSha });
    }
    for (const [oldSha, replacement] of replacements) {
      state.commits.delete(oldSha);
      state.commits.set(replacement.sha, replacement);
      for (const [ref, currentSha] of state.refs) {
        if (currentSha === oldSha) state.refs.set(ref, replacement.sha);
      }
    }
    return [...replacements.values()][0]?.sha ?? "";
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
    const result = await this.#flattenTree(state, treeSha);
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
    const flattened = await this.#flattenTree(state, baseTreeSha);
    const leaves = new Map(flattened.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, { ...entry }]));
    for (const update of updates) {
      validateUpdatePath(update.path);
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
    const sha = await this.#buildTree(state.trees, [...leaves.values()]);
    this.#finish("createTree");
    return sha;
  }

  async createCommit(repository: Repository, input: CreateCommitInput): Promise<GitCommit> {
    this.#begin("createCommit");
    const state = this.#repo(repository);
    if (!state.trees.has(input.treeSha) || !state.commits.has(input.parentSha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    const sha = await gitCommitSha(this.#commitContent(input.treeSha, input.parentSha, input.message));
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
    if (fault.code === "TREE_TRUNCATED") throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    if (fault.code === "API_CONFLICT") {
      const code = operation === "createRef" ? "BRANCH_CONFLICT"
        : operation === "createPullRequest" ? "PULL_REQUEST_CONFLICT"
          : "BASE_TREE_CONFLICT";
      throw new PublicationFailure(code);
    }
    if (fault.code === "PR_LIST_INCOMPLETE") throw new PublicationFailure("GITHUB_UNAVAILABLE");
    const options = fault.code === "GITHUB_RATE_LIMITED" ? { retryAfterSeconds: fault.retryAfterSeconds ?? 60 } : {};
    throw new PublicationFailure(fault.code, options);
  }

  async #flattenTree(state: MockRepository, treeSha: string, prefix = "", depth = 0): Promise<GitTreeEntry[]> {
    if (depth > 64) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    const immediate = state.trees.get(treeSha);
    if (!immediate) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    const result: GitTreeEntry[] = [];
    for (const entry of immediate) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path;
      const fullEntry = { ...entry, path };
      result.push(fullEntry);
      if (entry.type === "tree") result.push(...await this.#flattenTree(state, entry.sha, path, depth + 1));
    }
    return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }

  async #buildTree(trees: Map<string, GitTreeEntry[]>, leaves: GitTreeEntry[]): Promise<string> {
    const root: TreeNode = { children: new Map() };
    for (const leaf of leaves) {
      validateUpdatePath(leaf.path);
      const parts = leaf.path.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (node.entry) throw new PublicationFailure("BASE_TREE_CONFLICT");
        let child = node.children.get(part);
        if (!child) {
          child = { children: new Map() };
          node.children.set(part, child);
        }
        node = child;
      }
      const name = parts.at(-1)!;
      const child = node.children.get(name);
      if (child && child.children.size > 0) throw new PublicationFailure("BASE_TREE_CONFLICT");
      if (child?.entry) throw new PublicationFailure("BASE_TREE_CONFLICT");
      node.children.set(name, { entry: { ...leaf, path: name }, children: new Map() });
    }
    const emit = async (node: TreeNode): Promise<string> => {
      const entries: GitTreeEntry[] = [];
      for (const [name, child] of node.children) {
        if (child.entry) {
          entries.push({ ...child.entry, path: name });
        } else {
          const sha = await emit(child);
          entries.push({ path: name, mode: "040000", type: "tree", sha });
        }
      }
      for (const entry of entries) {
        if (!this.#objectInTreeBuild(entry, trees)) {
          // Leaf object validation occurs when inserting updates and seeding; preserve unknown base entries only in malformed fixtures.
          if (entry.type !== "tree") throw new PublicationFailure("GITHUB_UNAVAILABLE");
        }
      }
      const sha = await gitTreeSha(entries);
      trees.set(sha, entries.map((entry) => ({ ...entry })));
      return sha;
    };
    return emit(root);
  }

  #objectInTreeBuild(entry: GitTreeEntry, trees: Map<string, GitTreeEntry[]>): boolean {
    return entry.type === "tree" ? trees.has(entry.sha) : true;
  }

  #objectExists(state: MockRepository, entry: GitTreeEntry): boolean {
    if (entry.type === "tree" && entry.mode === "040000") return state.trees.has(entry.sha);
    if (entry.type === "blob" && ["100644", "100755", "120000"].includes(entry.mode)) return state.blobs.has(entry.sha);
    if (entry.type === "commit" && entry.mode === "160000") return state.commits.has(entry.sha);
    return false;
  }

  #commitContent(treeSha: string, parentSha: string | undefined, message: string): Uint8Array {
    const identity = "Kirisame Test <kirisame@example.invalid> 0 +0000";
    const headers = [`tree ${treeSha}`, ...(parentSha ? [`parent ${parentSha}`] : []), `author ${identity}`, `committer ${identity}`];
    return utf8(`${headers.join("\n")}\n\n${message.replace(/\n*$/u, "")}\n`);
  }
}

function normalizeRef(value: string): string {
  if (value.startsWith("refs/heads/")) return value.slice("refs/heads/".length);
  return value;
}

function validateUpdatePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  }
}

function assertNoPathCollisions(paths: string[]): void {
  const existing = new Set(paths);
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (existing.has(parts.slice(0, index).join("/"))) throw new PublicationFailure("BASE_TREE_CONFLICT");
    }
  }
}
