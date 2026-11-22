import type { Repository } from "../contracts/types.js";
import type {
  CreateCommitInput,
  CreatePullRequestInput,
  GitCommit,
  GitTreeEntry,
  GitTreeUpdate,
  PullRequestRecord,
  RepositoryIdentity,
} from "./types.js";

/** Narrow boundary for the GitHub Git Data and Pull Requests APIs. */
export interface GitHubAdapter {
  resolveRepository(repository: Repository, operation: "branch" | "pr"): Promise<RepositoryIdentity>;
  readRef(repository: Repository, ref: string): Promise<string | undefined>;
  readCommit(repository: Repository, sha: string): Promise<GitCommit | undefined>;
  readTree(repository: Repository, treeSha: string): Promise<GitTreeEntry[]>;
  readBlob(repository: Repository, sha: string): Promise<Uint8Array | undefined>;
  createBlob(repository: Repository, content: Uint8Array): Promise<string>;
  createTree(repository: Repository, baseTreeSha: string, updates: GitTreeUpdate[]): Promise<string>;
  createCommit(repository: Repository, input: CreateCommitInput): Promise<GitCommit>;
  createRef(repository: Repository, ref: string, sha: string): Promise<void>;
  listPullRequests(repository: Repository, headRef: string, baseRef: string): Promise<PullRequestRecord[]>;
  createPullRequest(repository: Repository, input: CreatePullRequestInput): Promise<PullRequestRecord>;
}
