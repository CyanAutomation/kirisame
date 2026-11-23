import { utf8 } from "../contracts/integrity.js";
import { PublicationFailure } from "../errors/publication-error.js";
import { validateGitObjectPath } from "./git-paths.js";
import { gitTreeSha } from "./git-objects.js";
import type {
  GitCommit,
  GitTreeEntry,
  PullRequestRecord,
  RepositoryIdentity,
} from "./types.js";

export interface MockRepositoryState {
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

export const MOCK_BASE_FILES = [
  { path: "docs/guide.md", content: "Current guide.\n" },
  { path: "obsolete.txt", content: "Obsolete file.\n" },
] as const;

export const refName = (ref: string): string => `refs/heads/${normalizeRef(ref)}`;

export function normalizeRef(value: string): string {
  if (value.startsWith("refs/heads/")) return value.slice("refs/heads/".length);
  return value;
}

export function mockCommitContent(treeSha: string, parentSha: string | undefined, message: string): Uint8Array {
  const identity = "Kirisame Test <kirisame@example.invalid> 0 +0000";
  const headers = [`tree ${treeSha}`, ...(parentSha ? [`parent ${parentSha}`] : []), `author ${identity}`, `committer ${identity}`];
  return utf8(`${headers.join("\n")}\n\n${message.replace(/\n*$/u, "")}\n`);
}

export async function flattenMockTree(
  state: MockRepositoryState,
  treeSha: string,
  prefix = "",
  depth = 0,
): Promise<GitTreeEntry[]> {
  if (depth > 64) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  const immediate = state.trees.get(treeSha);
  if (!immediate) throw new PublicationFailure("GITHUB_UNAVAILABLE");
  const result: GitTreeEntry[] = [];
  for (const entry of immediate) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path;
    result.push({ ...entry, path });
    if (entry.type === "tree") result.push(...await flattenMockTree(state, entry.sha, path, depth + 1));
  }
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export async function buildMockTree(trees: Map<string, GitTreeEntry[]>, leaves: GitTreeEntry[]): Promise<string> {
  const root: TreeNode = { children: new Map() };
  for (const leaf of leaves) addLeaf(root, leaf);
  return emitMockTree(root, trees);
}

function addLeaf(root: TreeNode, leaf: GitTreeEntry): void {
  validateGitObjectPath(leaf.path);
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

async function emitMockTree(node: TreeNode, trees: Map<string, GitTreeEntry[]>): Promise<string> {
  const entries: GitTreeEntry[] = [];
  for (const [name, child] of node.children) {
    if (child.entry) {
      entries.push({ ...child.entry, path: name });
    } else {
      const sha = await emitMockTree(child, trees);
      entries.push({ path: name, mode: "040000", type: "tree", sha });
    }
  }
  const sha = await gitTreeSha(entries);
  trees.set(sha, entries.map((entry) => ({ ...entry })));
  return sha;
}

export function mockObjectExists(state: MockRepositoryState, entry: GitTreeEntry): boolean {
  if (entry.type === "tree" && entry.mode === "040000") return state.trees.has(entry.sha);
  if (entry.type === "blob" && ["100644", "100755", "120000"].includes(entry.mode)) return state.blobs.has(entry.sha);
  if (entry.type === "commit" && entry.mode === "160000") return state.commits.has(entry.sha);
  return false;
}

export function assertNoPathCollisions(paths: string[]): void {
  const existing = new Set(paths);
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (existing.has(parts.slice(0, index).join("/"))) throw new PublicationFailure("BASE_TREE_CONFLICT");
    }
  }
}
