import { describe, expect, it } from "vitest";
import branchFixture from "../contracts/valid/branch-publication-request.json";
import prFixture from "../contracts/valid/pr-publication-request.json";
import { canonicalizeJson } from "../../src/contracts/canonicalize.js";
import { bytesToBase64, sha256Hex, utf8 } from "../../src/contracts/integrity.js";
import type { PublicationRequest, Repository } from "../../src/contracts/types.js";
import { MockGitHubAdapter } from "../../src/github/MockGitHubAdapter.js";
import { RealGitHubAdapter } from "../../src/github/RealGitHubAdapter.js";
import type { PullRequestRecord } from "../../src/github/types.js";
import { PublicationService } from "../../src/publication/service.js";
import { AllowlistedPublicationPolicy } from "../../src/publication/policy.js";
import { generateTestGitHubAppKeys } from "./github-test-utils.js";

const fixedNow = 1_800_000_000_000;

describe("HTTP-backed GitHub publication", () => {
  it("publishes add, modify and delete changes and reconciles the same PR on replay", async () => {
    const request = await makeRequest("pr");
    const backend = await createHttpGitHubBackend(request.repository);
    const adapter = new RealGitHubAdapter(backend.keys.credentials, { fetch: backend.fetch, now: () => fixedNow });
    const service = new PublicationService(adapter, new AllowlistedPublicationPolicy([request.repository]));

    const first = await service.publish(request);
    const replay = await service.publish(request);

    expect(first.outcome).toBe("pr_published");
    expect(first.pullRequest?.state).toBe("open");
    expect(replay.outcome).toBe("pr_published");
    expect(replay.branch?.reused).toBe(true);
    expect(backend.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs"))).toHaveLength(1);
    expect(backend.calls.filter((call) => call.method === "POST" && call.path.endsWith("/pulls"))).toHaveLength(1);
    expect(backend.calls.some((call) => call.path.endsWith("/git/trees") && call.method === "POST")).toBe(true);
  });

  it("reconciles a lost branch-create response without repeating the ref mutation", async () => {
    const request = await makeRequest("branch");
    const backend = await createHttpGitHubBackend(request.repository, { loseMutationResponse: "/git/refs" });
    const adapter = new RealGitHubAdapter(backend.keys.credentials, { fetch: backend.fetch, now: () => fixedNow });
    const service = new PublicationService(adapter, new AllowlistedPublicationPolicy([request.repository]));

    const result = await service.publish(request);

    expect(result.outcome).toBe("branch_published");
    expect(backend.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs"))).toHaveLength(1);
  });

  it("reconciles a timeout after PR creation without issuing a duplicate PR", async () => {
    const request = await makeRequest("pr");
    const backend = await createHttpGitHubBackend(request.repository, { loseMutationResponse: "/pulls" });
    const adapter = new RealGitHubAdapter(backend.keys.credentials, { fetch: backend.fetch, now: () => fixedNow });
    const service = new PublicationService(adapter, new AllowlistedPublicationPolicy([request.repository]));

    const result = await service.publish(request);

    expect(result.outcome).toBe("pr_published");
    expect(result.pullRequest?.state).toBe("open");
    expect(backend.calls.filter((call) => call.method === "POST" && call.path.endsWith("/pulls"))).toHaveLength(1);
  });

  it("rejects a repository before making any GitHub request", async () => {
    const request = await makeRequest("branch");
    const backend = await createHttpGitHubBackend(request.repository);
    const adapter = new RealGitHubAdapter(backend.keys.credentials, { fetch: backend.fetch, now: () => fixedNow });
    const service = new PublicationService(adapter, new AllowlistedPublicationPolicy([]));

    const result = await service.publish(request);

    expect(result.error?.code).toBe("REPOSITORY_NOT_ALLOWED");
    expect(backend.calls).toEqual([]);
  });
});

async function makeRequest(mode: "branch" | "pr"): Promise<PublicationRequest> {
  const request = structuredClone(mode === "pr" ? prFixture.value : branchFixture.value) as unknown as PublicationRequest;
  request.publicationId = mode === "pr"
    ? "019a6000-0000-7000-8000-000000000098"
    : "019a6000-0000-7000-8000-000000000099";
  request.headRef = `kirisame/p/${request.publicationId}`;
  const canonical = canonicalizeJson(request.artifact);
  if (canonical === undefined) throw new Error("artifact did not canonicalize");
  request.artifactDigest = `sha256:${await sha256Hex(utf8(canonical))}`;
  return request;
}

async function createHttpGitHubBackend(
  repository: Repository,
  options: { loseMutationResponse?: string } = {},
) {
  const keys = await generateTestGitHubAppKeys();
  const state = new MockGitHubAdapter();
  const request = await makeRequest("branch");
  request.repository = repository;
  request.artifact.repository = repository;
  await state.seedForRequest(request);
  const calls: Array<{ method: string; path: string }> = [];
  let lostMutationResponse = options.loseMutationResponse;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    calls.push({ method, path });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (path === `/repos/${repository.owner}/${repository.name}/installation`) {
      return json({ id: 42, app_id: 3345400, account: { login: repository.owner }, suspended_at: null,
        permissions: { metadata: "read", contents: "write", pull_requests: "write" } });
    }
    if (path === "/app/installations/42/access_tokens" && method === "POST") {
      const permissions = body.permissions as Record<string, string>;
      return json({ token: "test-installation-token", expires_at: new Date(fixedNow + 3_600_000).toISOString(),
        permissions: { metadata: "read", ...permissions },
        repositories: [{ id: 77, full_name: `${repository.owner}/${repository.name}` }] }, 201);
    }
    if (path === `/repos/${repository.owner}/${repository.name}`) return json({ id: 77, full_name: `${repository.owner}/${repository.name}` });
    if (!path.startsWith(`/repos/${repository.owner}/${repository.name}/`)) return json({ message: "Not found" }, 404);

    const suffix = path.slice(`/repos/${repository.owner}/${repository.name}/`.length);
    try {
      if (suffix.startsWith("git/ref/heads/")) {
        const ref = suffix.slice("git/ref/heads/".length);
        if (method === "GET") {
          const sha = await state.readRef(repository, ref);
          return sha ? json({ ref: `refs/heads/${ref}`, object: { sha, type: "commit" } }) : json({ message: "Not found" }, 404);
        }
      }
      if (suffix.startsWith("git/commits/")) {
        const sha = suffix.slice("git/commits/".length);
        const commit = await state.readCommit(repository, sha);
        return commit ? json({ sha, tree: { sha: commit.treeSha }, parents: commit.parentSha ? [{ sha: commit.parentSha }] : [], message: commit.message })
          : json({ message: "Not found" }, 404);
      }
      if (suffix.startsWith("git/trees/")) {
        const sha = suffix.slice("git/trees/".length);
        const entries = await state.readTree(repository, sha);
        return json({ sha, truncated: false, tree: entries.filter((entry) => !entry.path.includes("/")) });
      }
      if (suffix.startsWith("git/blobs/")) {
        const sha = suffix.slice("git/blobs/".length);
        const bytes = await state.readBlob(repository, sha);
        return bytes ? json({ sha, size: bytes.byteLength, encoding: "base64", content: bytesToBase64(bytes) })
          : json({ message: "Not found" }, 404);
      }
      if (suffix === "git/blobs" && method === "POST") {
        const content = decodeBase64(String(body.content));
        const sha = await state.createBlob(repository, content);
        const response = json({ sha }, 201);
        return loseAfterMutation(path, response);
      }
      if (suffix === "git/trees" && method === "POST") {
        const updates = body.tree as Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }>;
        const sha = await state.createTree(repository, String(body.base_tree), updates);
        const response = json({ sha }, 201);
        return loseAfterMutation(path, response);
      }
      if (suffix === "git/commits" && method === "POST") {
        const parents = body.parents as string[];
        const commit = await state.createCommit(repository, { treeSha: String(body.tree), parentSha: parents[0]!, message: String(body.message) });
        const response = json({ sha: commit.sha, tree: { sha: commit.treeSha }, parents: [{ sha: commit.parentSha }], message: commit.message }, 201);
        return loseAfterMutation(path, response);
      }
      if (suffix === "git/refs" && method === "POST") {
        const ref = String(body.ref).replace(/^refs\/heads\//u, "");
        await state.createRef(repository, ref, String(body.sha));
        const response = json({ ref: String(body.ref), object: { sha: String(body.sha), type: "commit" } }, 201);
        return loseAfterMutation(path, response);
      }
      if (suffix.startsWith("pulls")) {
        if (method === "GET") {
          const head = url.searchParams.get("head")?.split(":").at(-1) ?? "";
          const base = url.searchParams.get("base") ?? "";
          const pulls = await state.listPullRequests(repository, head, base);
          return json(pulls.map(toPullRequestJson));
        }
        if (method === "POST") {
          const pull = await state.createPullRequest(repository, {
            title: String(body.title), body: String(body.body), headRef: String(body.head), baseRef: String(body.base),
          });
          const response = json(toPullRequestJson(pull), 201);
          return loseAfterMutation(path, response);
        }
      }
      return json({ message: "Not found" }, 404);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const status = code === "BRANCH_CONFLICT" || code === "PULL_REQUEST_CONFLICT" || code === "BASE_TREE_CONFLICT" ? 422 : 500;
      return json({ message: "Simulated GitHub API error" }, status);
    }
  };

  function loseAfterMutation(path: string, response: Response): Response {
    if (lostMutationResponse && path.endsWith(lostMutationResponse)) {
      lostMutationResponse = undefined;
      throw new Error("simulated lost response after remote mutation");
    }
    return response;
  }

  return { keys, calls, fetch };
}

function toPullRequestJson(pull: PullRequestRecord): Record<string, unknown> {
  return {
    number: pull.number,
    html_url: pull.url,
    state: pull.state === "merged" ? "closed" : pull.state,
    merged_at: pull.state === "merged" ? "2026-11-22T00:00:00Z" : null,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, repo: { full_name: `${pull.headRepository.owner}/${pull.headRepository.name}` } },
    base: { ref: pull.baseRef, repo: { full_name: `${pull.baseRepository.owner}/${pull.baseRepository.name}` } },
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
