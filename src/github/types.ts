import type { Repository } from "../contracts/types.js";

export type GitObjectType = "blob" | "tree" | "commit" | string;
export type GitObjectMode = "100644" | "100755" | "120000" | "160000" | "040000" | string;

export interface GitTreeEntry {
  path: string;
  mode: GitObjectMode;
  type: GitObjectType;
  sha: string;
}

export interface GitCommit {
  sha: string;
  treeSha: string;
  parentSha?: string;
  message: string;
}

export interface GitTreeUpdate {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string | null;
}

export interface CreateCommitInput {
  treeSha: string;
  parentSha: string;
  message: string;
}

export interface PullRequestRecord {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  headRef: string;
  baseRef: string;
  headRepository: Repository;
  baseRepository: Repository;
  title: string;
  body: string;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
}

export type GitHubOperation =
  | "resolveRepository"
  | "readRef"
  | "readCommit"
  | "readTree"
  | "readBlob"
  | "createBlob"
  | "createTree"
  | "createCommit"
  | "createRef"
  | "listPullRequests"
  | "createPullRequest";

export interface RepositoryIdentity extends Repository {
  fullName: string;
  id: number;
  installationId: number;
}
