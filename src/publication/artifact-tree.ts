import { canonicalBase64ToBytes } from "../contracts/integrity.js";
import type { PublicationRequest } from "../contracts/types.js";
import { PublicationFailure } from "../errors/publication-error.js";
import type { GitHubAdapter } from "../github/GitHubAdapter.js";
import { gitBlobSha } from "../github/git-objects.js";
import type { GitTreeEntry } from "../github/types.js";
import { isAttributesPath, rejectLfsGovernedChanges } from "./git-attributes.js";

type ArtifactChange = PublicationRequest["artifact"]["files"][number];

export async function applyArtifactToTree(
  adapter: GitHubAdapter,
  request: PublicationRequest,
  baseTree: GitTreeEntry[],
): Promise<GitTreeEntry[]> {
  if (request.artifact.files.some((file) => isAttributesPath(file.path))) {
    throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  }
  await rejectLfsGovernedChanges(
    baseTree,
    request.artifact.files.map((file) => file.path),
    (sha) => readVerifiedBlob(adapter, request, sha),
  );

  const leafEntries = baseTree.filter((entry) => entry.type !== "tree");
  const expected = new Map(leafEntries.map((entry) => [entry.path, { ...entry }]));
  for (const change of request.artifact.files) {
    await applyChange(change, request, adapter, baseTree, leafEntries, expected);
  }
  return [...expected.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function applyChange(
  change: ArtifactChange,
  request: PublicationRequest,
  adapter: GitHubAdapter,
  baseTree: GitTreeEntry[],
  leafEntries: GitTreeEntry[],
  expected: Map<string, GitTreeEntry>,
): Promise<void> {
  const exact = baseTree.find((entry) => entry.path === change.path);
  const pathCollision = leafEntries.some((entry) => change.path.startsWith(`${entry.path}/`)
    || entry.path.startsWith(`${change.path}/`));
  if (pathCollision) throw new PublicationFailure("BASE_TREE_CONFLICT");

  if (change.operation === "add") {
    if (exact) throw new PublicationFailure(exact.type === "blob" && exact.mode !== "100644" ? "UNSUPPORTED_GIT_OBJECT" : "BASE_TREE_CONFLICT");
    expected.set(change.path, { path: change.path, mode: "100644", type: "blob", sha: await contentBlobSha(change) });
    return;
  }

  const existing = validateExistingChange(change, exact);
  const prior = await readVerifiedBlob(adapter, request, existing.sha);
  if (!prior) throw new PublicationFailure("GITHUB_UNAVAILABLE");
  rejectUnsupportedPriorContent(prior);

  if (change.operation === "delete") expected.delete(change.path);
  else expected.set(change.path, { path: change.path, mode: "100644", type: "blob", sha: await contentBlobSha(change) });
}

function validateExistingChange(change: Exclude<ArtifactChange, { operation: "add" }>, exact: GitTreeEntry | undefined): GitTreeEntry {
  if (!exact) throw new PublicationFailure("BASE_TREE_CONFLICT");
  if (exact.type === "tree" || exact.mode === "040000") throw new PublicationFailure("BASE_TREE_CONFLICT");
  if (exact.type !== "blob" || exact.mode !== "100644") throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  if (exact.sha !== change.baseBlobSha) throw new PublicationFailure("BASE_TREE_CONFLICT");
  return exact;
}

export async function compareExpectedTree(
  adapter: GitHubAdapter,
  request: PublicationRequest,
  treeSha: string,
  expected: GitTreeEntry[],
): Promise<void> {
  const actual = await adapter.readTree(request.repository, treeSha);
  compareExpectedEntries(actual, expected);
}

export function compareExpectedEntries(actual: GitTreeEntry[], expected: GitTreeEntry[]): void {
  const actualValues = treeFingerprint(actual);
  const expectedValues = treeFingerprint(expected);
  if (actualValues.length !== expectedValues.length || actualValues.some((value, index) => value !== expectedValues[index])) {
    throw new PublicationFailure("BRANCH_CONFLICT");
  }
}

export function rejectNoOp(baseTree: GitTreeEntry[], expected: GitTreeEntry[]): void {
  const before = treeFingerprint(baseTree);
  const after = treeFingerprint(expected);
  if (before.length === after.length && before.every((entry, index) => entry === after[index])) {
    throw new PublicationFailure("NO_CHANGES");
  }
}

function treeFingerprint(entries: GitTreeEntry[]): string[] {
  return entries.filter((entry) => entry.type !== "tree")
    .map((entry) => `${entry.path}\0${entry.mode}\0${entry.type}\0${entry.type === "tree" ? "" : entry.sha}`)
    .sort();
}

async function contentBlobSha(change: Exclude<ArtifactChange, { operation: "delete" }>): Promise<string> {
  const bytes = canonicalBase64ToBytes(change.content.data);
  if (!bytes) throw new PublicationFailure("ARTIFACT_INVALID");
  return gitBlobSha(bytes);
}

async function readVerifiedBlob(requestAdapter: GitHubAdapter, request: PublicationRequest, sha: string): Promise<Uint8Array | undefined> {
  const content = await requestAdapter.readBlob(request.repository, sha);
  if (!content) return undefined;
  if (await gitBlobSha(content) !== sha) throw new PublicationFailure("GITHUB_UNAVAILABLE");
  return content;
}

function rejectUnsupportedPriorContent(bytes: Uint8Array): void {
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
