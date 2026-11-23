import { beforeAll, describe, expect, it, vi } from "vitest";
import documentedGitCommit from "../fixtures/github-get-commit-response.json";
import documentedGitTree from "../fixtures/github-get-tree-response.json";
import { bytesToBase64, utf8 } from "../../src/contracts/integrity.js";
import { RealGitHubAdapter } from "../../src/github/RealGitHubAdapter.js";
import { gitBlobSha } from "../../src/github/git-objects.js";
import { validateGitObjectPath } from "../../src/github/git-paths.js";
import type { Repository } from "../../src/contracts/types.js";
import { generateTestGitHubAppKeys, type TestGitHubAppKeys } from "./github-test-utils.js";

const repository: Repository = { owner: "CyanAutomation", name: "demo-app" };
const now = 1_800_000_000_000;
let keys: TestGitHubAppKeys;

describe("Git object path validation", () => {
  it.each(["", "/absolute", "a\\b", "a//b", "a/./b", "a/../b"])("rejects unsafe path %j", (path) => {
    expect(() => validateGitObjectPath(path)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_GIT_OBJECT" }));
  });

  it("allows normalized relative paths", () => {
    expect(() => validateGitObjectPath("docs/guide.md")).not.toThrow();
  });
});

beforeAll(async () => {
  keys = await generateTestGitHubAppKeys();
});

describe("GitHub App installation token scope", () => {
  it("resolves an installation and requests exactly the repository and permissions for branch mode", async () => {
    const fixture = createAdapterFixture();
    const identity = await fixture.adapter.resolveRepository(repository, "branch");
    const tokenCall = fixture.calls.find((call) => call.url.pathname.endsWith("/access_tokens"));
    const body = JSON.parse(tokenCall!.body!) as Record<string, unknown>;

    expect(identity).toMatchObject({ fullName: "CyanAutomation/demo-app", id: 77, installationId: 42 });
    expect(body).toEqual({ repositories: ["demo-app"], permissions: { contents: "write" } });
    expect(fixture.calls.every((call) => call.headers.get("accept") === "application/vnd.github+json")).toBe(true);
    expect(fixture.calls.every((call) => call.headers.get("x-github-api-version") === "2026-03-10")).toBe(true);
    expect(fixture.calls.find((call) => call.url.pathname.endsWith("/access_tokens"))?.headers.get("authorization"))
      .toMatch(/^Bearer eyJ/u);
    expect(fixture.calls.at(-1)?.headers.get("authorization")).toBe("Bearer opaque-installation-token");
  });

  it("requests pull request write only for PR mode", async () => {
    const fixture = createAdapterFixture();
    await fixture.adapter.resolveRepository(repository, "pr");
    const tokenCall = fixture.calls.find((call) => call.url.pathname.endsWith("/access_tokens"));
    const body = JSON.parse(tokenCall!.body!) as Record<string, unknown>;
    expect(body).toEqual({ repositories: ["demo-app"], permissions: { contents: "write", pull_requests: "write" } });
  });

  it("rejects a missing or suspended installation before token issuance", async () => {
    const missing = createAdapterFixture({ installationStatus: 404 });
    await expect(missing.adapter.resolveRepository(repository, "pr"))
      .rejects.toMatchObject({ code: "APP_NOT_INSTALLED" });
    expect(missing.calls.some((call) => call.url.pathname.endsWith("/access_tokens"))).toBe(false);

    const suspended = createAdapterFixture({ suspendedAt: "2026-11-01T00:00:00Z" });
    await expect(suspended.adapter.resolveRepository(repository, "branch"))
      .rejects.toMatchObject({ code: "APP_NOT_INSTALLED" });
    expect(suspended.calls.some((call) => call.url.pathname.endsWith("/access_tokens"))).toBe(false);
  });

  it("rejects missing permissions and an inconsistent App ID before token issuance", async () => {
    const denied = createAdapterFixture({ installationPermissions: { contents: "read", metadata: "read" } });
    await expect(denied.adapter.resolveRepository(repository, "branch"))
      .rejects.toMatchObject({ code: "GITHUB_PERMISSION_DENIED" });
    expect(denied.calls.some((call) => call.url.pathname.endsWith("/access_tokens"))).toBe(false);

    const wrongApp = createAdapterFixture({ installationAppId: 9 });
    await expect(wrongApp.adapter.resolveRepository(repository, "branch"))
      .rejects.toMatchObject({ code: "APP_NOT_INSTALLED" });
    expect(wrongApp.calls.some((call) => call.url.pathname.endsWith("/access_tokens"))).toBe(false);

    expect(() => new RealGitHubAdapter({ ...keys.credentials, appId: "9" }, { fetch: async () => { throw new Error("unexpected"); } }))
      .toThrow(expect.objectContaining({ code: "PUBLISHING_UNAVAILABLE" }));
  });

  it("rejects an over-scoped token and honors its returned expiration", async () => {
    const broad = createAdapterFixture({ tokenPermissions: { contents: "write", pull_requests: "write", metadata: "read" } });
    await expect(broad.adapter.resolveRepository(repository, "branch"))
      .rejects.toMatchObject({ code: "GITHUB_PERMISSION_DENIED" });

    const expired = createAdapterFixture({ tokenExpiresAt: new Date(now - 1).toISOString() });
    await expect(expired.adapter.resolveRepository(repository, "branch"))
      .rejects.toMatchObject({ code: "GITHUB_AUTH_INVALID" });
  });

  it("rejects a token scoped to the wrong repository", async () => {
    const fixture = createAdapterFixture({ tokenRepositories: [{ id: 88, fullName: "CyanAutomation/other" }] });
    await expect(fixture.adapter.resolveRepository(repository, "branch"))
      .rejects.toMatchObject({ code: "GITHUB_AUTH_INVALID" });
  });

  it("logs only safe API categories and timing, never credentials", async () => {
    const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const fixture = createAdapterFixture();
      await fixture.adapter.resolveRepository(repository, "branch");
      const logLines = logger.mock.calls.map(([line]) => String(line));
      expect(logLines.some((line) => line.includes('"category":"installation_token"'))).toBe(true);
      expect(logLines.every((line) => line.includes('"durationMs":'))).toBe(true);
      expect(logLines.join("\n")).not.toContain("opaque-installation-token");
      expect(logLines.join("\n")).not.toContain(keys.credentials.privateKey);
    } finally {
      logger.mockRestore();
    }
  });
});

describe("GitHub REST Git Data adapter", () => {
  it("parses the documented top-level Git Data commit response", async () => {
    const fixture = createAdapterFixture({ apiHandler: async (url) => url.pathname.endsWith(`/git/commits/${documentedGitCommit.sha}`)
      ? json(documentedGitCommit)
      : undefined });
    await fixture.adapter.resolveRepository(repository, "branch");

    await expect(fixture.adapter.readCommit(repository, documentedGitCommit.sha)).resolves.toEqual({
      sha: documentedGitCommit.sha,
      treeSha: documentedGitCommit.tree.sha,
      parentSha: documentedGitCommit.parents[0]!.sha,
      message: documentedGitCommit.message,
    });
  });

  it("rejects the separate repository Commits API's nested commit shape for a Git Data endpoint", async () => {
    const sha = "a".repeat(40);
    const fixture = createAdapterFixture({ apiHandler: async (url) => url.pathname.endsWith(`/git/commits/${sha}`)
      ? json({ sha, commit: { tree: { sha: "b".repeat(40) }, parents: [], message: "wrong endpoint shape" } })
      : undefined });
    await fixture.adapter.resolveRepository(repository, "branch");

    await expect(fixture.adapter.readCommit(repository, sha)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });

  it.each([
    { label: "missing", value: undefined },
    { label: "non-string", value: 7 },
    { label: "empty", value: "" },
  ])("rejects a $label commit message as an unavailable GitHub response", async ({ value }) => {
    const sha = "a".repeat(40);
    const response = { sha, tree: { sha: "b".repeat(40) }, parents: [], ...(value === undefined ? {} : { message: value }) };
    const fixture = createAdapterFixture({ apiHandler: async (url) => url.pathname.endsWith(`/git/commits/${sha}`) ? json(response) : undefined });
    await fixture.adapter.resolveRepository(repository, "branch");

    await expect(fixture.adapter.readCommit(repository, sha)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });

  it.each([
    { label: "malformed parents", update: { parents: [{ sha: 42 }] } },
    { label: "invalid tree SHA", update: { tree: { sha: "not-a-sha" } } },
    { label: "returned SHA mismatch", update: { sha: "c".repeat(40) } },
  ])("rejects a Git Data commit with $label", async ({ update }) => {
    const sha = "a".repeat(40);
    const fixture = createAdapterFixture({ apiHandler: async (url) => url.pathname.endsWith(`/git/commits/${sha}`)
      ? json({ ...documentedGitCommit, sha, ...update })
      : undefined });
    await fixture.adapter.resolveRepository(repository, "branch");

    await expect(fixture.adapter.readCommit(repository, sha)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });

  it("rejects a created commit that returns a different tree SHA", async () => {
    const expectedTreeSha = "b".repeat(40);
    const fixture = createAdapterFixture({ apiHandler: async (url, init) => url.pathname.endsWith("/git/commits") && init?.method === "POST"
      ? json({ sha: "a".repeat(40), tree: { sha: "c".repeat(40) }, parents: [{ sha: "d".repeat(40) }], message: "new commit" }, 201)
      : undefined });
    await fixture.adapter.resolveRepository(repository, "branch");

    await expect(fixture.adapter.createCommit(repository, {
      treeSha: expectedTreeSha,
      parentSha: "d".repeat(40),
      message: "new commit",
    })).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });

  it("accepts a realistic documented Git tree response with nested trees", async () => {
    const nestedTreeSha = "f484d249c660418515fb01c2b9662073663c242e";
    const fixture = createAdapterFixture({ apiHandler: async (url) => {
      if (url.pathname.endsWith(`/git/trees/${documentedGitTree.sha}`)) return json(documentedGitTree);
      if (url.pathname.endsWith(`/git/trees/${nestedTreeSha}`)) return json({ sha: nestedTreeSha, tree: [], truncated: false });
      return undefined;
    } });
    await fixture.adapter.resolveRepository(repository, "branch");

    await expect(fixture.adapter.readTree(repository, documentedGitTree.sha)).resolves.toEqual([
      { path: "file.rb", mode: "100644", type: "blob", sha: "44b4fc6d56897b048c772eb4087f854f46256132" },
      { path: "subdir", mode: "040000", type: "tree", sha: nestedTreeSha },
      { path: "exec_file", mode: "100755", type: "blob", sha: "45b983be36b73c0788dc9cbcb76cbb80fc7bb057" },
    ]);
  });

  it("distinguishes a missing ref from a malformed ref response", async () => {
    const sha = "a".repeat(40);
    const missing = createAdapterFixture({ apiHandler: async () => json({ message: "Not Found" }, 404) });
    await missing.adapter.resolveRepository(repository, "branch");
    await expect(missing.adapter.readRef(repository, "main")).resolves.toBeUndefined();

    const malformed = createAdapterFixture({ apiHandler: async () => json({ ref: "refs/heads/other", object: { sha } }) });
    await malformed.adapter.resolveRepository(repository, "branch");
    await expect(malformed.adapter.readRef(repository, "main")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });

  it("validates the create-ref response and retains create-only conflict behavior", async () => {
    const sha = "a".repeat(40);
    const wrongRef = createAdapterFixture({ apiHandler: async () => json({ ref: "refs/heads/other", object: { sha, type: "commit" } }, 201) });
    await wrongRef.adapter.resolveRepository(repository, "branch");
    await expect(wrongRef.adapter.createRef(repository, "main", sha)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });

    const conflict = createAdapterFixture({ apiHandler: async () => json({ message: "Reference already exists" }, 422) });
    await conflict.adapter.resolveRepository(repository, "branch");
    await expect(conflict.adapter.createRef(repository, "main", sha)).rejects.toMatchObject({ code: "BRANCH_CONFLICT" });
  });

  it("normalizes refs once at the API boundary", async () => {
    const fixture = createAdapterFixture({ apiHandler: async (url) => {
      if (url.pathname.endsWith("/git/ref/heads/kirisame/p/019a6000-0000-7000-8000-000000000001")) {
        return json({ ref: "refs/heads/kirisame/p/019a6000-0000-7000-8000-000000000001", object: { sha: "a".repeat(40) } });
      }
      return undefined;
    } });
    await fixture.adapter.resolveRepository(repository, "branch");

    expect(await fixture.adapter.readRef(repository, "refs/heads/kirisame/p/019a6000-0000-7000-8000-000000000001"))
      .toBe("a".repeat(40));
    const refRequest = fixture.calls.at(-1)!;
    expect(refRequest.url.pathname).toBe("/repos/CyanAutomation/demo-app/git/ref/heads/kirisame/p/019a6000-0000-7000-8000-000000000001");
  });

  it("recursively retrieves nested tree objects and rejects truncated or malformed trees", async () => {
    const root = "1".repeat(40);
    const nested = "2".repeat(40);
    const blob = "3".repeat(40);
    const fixture = createAdapterFixture({ apiHandler: async (url) => {
      if (url.pathname.endsWith(`/git/trees/${root}`)) return json({
        sha: root,
        truncated: false,
        tree: [
          { path: "docs", mode: "040000", type: "tree", sha: nested },
          { path: "README.md", mode: "100644", type: "blob", sha: blob },
        ],
      });
      if (url.pathname.endsWith(`/git/trees/${nested}`)) return json({
        sha: nested,
        truncated: false,
        tree: [{ path: "guide.md", mode: "100644", type: "blob", sha: blob }],
      });
      return undefined;
    } });
    await fixture.adapter.resolveRepository(repository, "branch");
    await expect(fixture.adapter.readTree(repository, root)).resolves.toEqual(expect.arrayContaining([
      { path: "docs", mode: "040000", type: "tree", sha: nested },
      { path: "docs/guide.md", mode: "100644", type: "blob", sha: blob },
      { path: "README.md", mode: "100644", type: "blob", sha: blob },
    ]));

    const truncated = createAdapterFixture({ apiHandler: async () => json({ sha: root, truncated: true, tree: [] }) });
    await truncated.adapter.resolveRepository(repository, "branch");
    await expect(truncated.adapter.readTree(repository, root)).rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });

    const invalidMode = createAdapterFixture({ apiHandler: async () => json({
      sha: root, truncated: false, tree: [{ path: "link", mode: "077777", type: "blob", sha: blob }],
    }) });
    await invalidMode.adapter.resolveRepository(repository, "branch");
    await expect(invalidMode.adapter.readTree(repository, root)).rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });

    const duplicateName = createAdapterFixture({ apiHandler: async () => json({
      sha: root,
      truncated: false,
      tree: [
        { path: "README.md", mode: "100644", type: "blob", sha: blob },
        { path: "README.md", mode: "100644", type: "blob", sha: blob },
      ],
    }) });
    await duplicateName.adapter.resolveRepository(repository, "branch");
    await expect(duplicateName.adapter.readTree(repository, root)).rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });
  });

  it("keeps concurrent tree entry limits isolated per traversal", async () => {
    const firstTree = "1".repeat(40);
    const secondTree = "2".repeat(40);
    const entries = Array.from({ length: 25_001 }, (_, index) => ({
      path: `file-${index}`,
      mode: "100644",
      type: "blob",
      sha: "3".repeat(40),
    }));
    const fixture = createAdapterFixture({ apiHandler: async (url) => {
      if (url.pathname.endsWith(`/git/trees/${firstTree}`)) {
        return json({ sha: firstTree, truncated: false, tree: entries });
      }
      if (url.pathname.endsWith(`/git/trees/${secondTree}`)) {
        return json({ sha: secondTree, truncated: false, tree: entries });
      }
      return undefined;
    } });
    await fixture.adapter.resolveRepository(repository, "branch");

    const [first, second] = await Promise.all([
      fixture.adapter.readTree(repository, firstTree),
      fixture.adapter.readTree(repository, secondTree),
    ]);
    expect(first).toHaveLength(entries.length);
    expect(second).toHaveLength(entries.length);
  });

  it.each([
    { label: "missing", value: undefined },
    { label: "non-string", value: 7 },
    { label: "empty", value: "" },
  ])("rejects a $label commit message as an unavailable GitHub response", async ({ value }) => {
    const sha = "a".repeat(40);
    const treeSha = "b".repeat(40);
    const commit = {
      tree: { sha: treeSha },
      parents: [],
      ...(value === undefined ? {} : { message: value }),
    };
    const fixture = createAdapterFixture({ apiHandler: async (url) => url.pathname.endsWith(`/git/commits/${sha}`)
      ? json({ sha, commit })
      : undefined });
    await fixture.adapter.resolveRepository(repository, "branch");

    await expect(fixture.adapter.readCommit(repository, sha)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });

  it("validates blob object identity and sends canonical base64 for blob creation", async () => {
    const bytes = utf8("hello from GitHub\n");
    const sha = await gitBlobSha(bytes);
    let blobRequest: Record<string, unknown> | undefined;
    const fixture = createAdapterFixture({ apiHandler: async (url, init) => {
      if (url.pathname.endsWith("/git/blobs") && init?.method === "POST") {
        blobRequest = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ sha }, 201);
      }
      if (url.pathname.endsWith(`/git/blobs/${sha}`)) return json({
        sha, size: bytes.byteLength, encoding: "base64", content: `${bytesToBase64(bytes).slice(0, 8)}\n${bytesToBase64(bytes).slice(8)}`,
      });
      return undefined;
    } });
    await fixture.adapter.resolveRepository(repository, "branch");
    await expect(fixture.adapter.readBlob(repository, sha)).resolves.toEqual(bytes);
    await expect(fixture.adapter.createBlob(repository, bytes)).resolves.toBe(sha);
    expect(blobRequest).toEqual({ content: bytesToBase64(bytes), encoding: "base64" });

    const mismatch = createAdapterFixture({ apiHandler: async (url) => url.pathname.endsWith(`/git/blobs/${sha}`) ? json({
      sha: "f".repeat(40), size: bytes.byteLength, encoding: "base64", content: bytesToBase64(bytes),
    }) : undefined });
    await mismatch.adapter.resolveRepository(repository, "branch");
    await expect(mismatch.adapter.readBlob(repository, sha)).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });

  it("sends nested tree updates, a single-parent commit, and create-only refs", async () => {
    const treeSha = "4".repeat(40);
    const commitSha = "5".repeat(40);
    const baseSha = "6".repeat(40);
    const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fixture = createAdapterFixture({ apiHandler: async (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push({ path: url.pathname, body });
        if (url.pathname.endsWith("/git/trees")) return json({ sha: treeSha }, 201);
        if (url.pathname.endsWith("/git/commits")) return json({
          sha: commitSha,
          tree: { sha: treeSha },
          parents: [{ sha: baseSha }],
          message: "test commit",
        }, 201);
        if (url.pathname.endsWith("/git/refs")) return json({ ref: "refs/heads/kirisame/p/x", object: { sha: commitSha, type: "commit" } }, 201);
      }
      return undefined;
    } });
    await fixture.adapter.resolveRepository(repository, "branch");
    await expect(fixture.adapter.createTree(repository, baseSha, [
      { path: "docs/guide.md", mode: "100644", type: "blob", sha: "7".repeat(40) },
      { path: "obsolete.txt", mode: "100644", type: "blob", sha: null },
    ])).resolves.toBe(treeSha);
    await expect(fixture.adapter.createCommit(repository, { treeSha, parentSha: baseSha, message: "test commit" }))
      .resolves.toMatchObject({ sha: commitSha, treeSha, parentSha: baseSha });
    await expect(fixture.adapter.createRef(repository, "kirisame/p/x", commitSha)).resolves.toBeUndefined();

    expect(bodies[0]?.body).toEqual({
      base_tree: baseSha,
      tree: [
        { path: "docs/guide.md", mode: "100644", type: "blob", sha: "7".repeat(40) },
        { path: "obsolete.txt", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(bodies[1]?.body).toEqual({ message: "test commit", tree: treeSha, parents: [baseSha] });
    expect(bodies[2]?.body).toEqual({ ref: "refs/heads/kirisame/p/x", sha: commitSha });
  });

  it("paginates pull requests across all states and reconciles exact head and base refs", async () => {
    const items = Array.from({ length: 101 }, (_, index) => pullRequestJson(index + 1));
    const fixture = createAdapterFixture({ apiHandler: async (url) => {
      if (!url.pathname.endsWith("/pulls")) return undefined;
      const page = Number(url.searchParams.get("page"));
      return json(page === 1 ? items.slice(0, 100) : items.slice(100));
    } });
    await fixture.adapter.resolveRepository(repository, "pr");
    const prs = await fixture.adapter.listPullRequests(repository, "refs/heads/kirisame/p/x", "main");
    const pages = fixture.calls.filter((call) => call.url.pathname.endsWith("/pulls"));

    expect(prs).toHaveLength(101);
    expect(pages.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(pages[0]?.url.searchParams.get("state")).toBe("all");
    expect(pages[0]?.url.searchParams.get("head")).toBe("CyanAutomation:kirisame/p/x");
  });

  it("creates non-draft pull requests and maps GitHub conflicts", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fixture = createAdapterFixture({ apiHandler: async (url, init) => {
      if (url.pathname.endsWith("/pulls") && init?.method === "POST") {
        sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json(pullRequestJson(9), 201);
      }
      return undefined;
    } });
    await fixture.adapter.resolveRepository(repository, "pr");
    const pr = await fixture.adapter.createPullRequest(repository, {
      title: "Kirisame publication", body: "Publication marker", headRef: "kirisame/p/x", baseRef: "main",
    });
    expect(pr).toMatchObject({ number: 9, state: "open", headRef: "kirisame/p/x", baseRef: "main" });
    expect(sentBody).toEqual({ title: "Kirisame publication", body: "Publication marker", head: "kirisame/p/x", base: "main", draft: false });

    const conflict = createAdapterFixture({ apiHandler: async () => json({ message: "Validation failed" }, 422) });
    await conflict.adapter.resolveRepository(repository, "pr");
    await expect(conflict.adapter.createPullRequest(repository, {
      title: "conflict", body: "", headRef: "kirisame/p/x", baseRef: "main",
    })).rejects.toMatchObject({ code: "PULL_REQUEST_CONFLICT" });
  });

  it("distinguishes permission denials, rate limits, server errors, and timeouts", async () => {
    const permission = createAdapterFixture({ apiHandler: async () => json({ message: "Resource not accessible by integration" }, 403) });
    await permission.adapter.resolveRepository(repository, "branch");
    await expect(permission.adapter.readRef(repository, "main")).rejects.toMatchObject({ code: "GITHUB_PERMISSION_DENIED" });

    const limited = createAdapterFixture({ apiHandler: async () => json({ message: "API rate limit exceeded" }, 403, {
      "retry-after": "45", "x-ratelimit-remaining": "0",
    }) });
    await limited.adapter.resolveRepository(repository, "branch");
    await expect(limited.adapter.readRef(repository, "main")).rejects.toMatchObject({
      code: "GITHUB_RATE_LIMITED", retryAfterSeconds: 45,
    });

    const server = createAdapterFixture({ apiHandler: async () => json({ message: "private body text" }, 503) });
    await server.adapter.resolveRepository(repository, "branch");
    await expect(server.adapter.readRef(repository, "main")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });

    const timeout = createAdapterFixture({ apiHandler: async (_url, _init) => new Promise<Response>((_resolve, reject) => {
      setTimeout(() => reject(new Error("network down")), 200);
    }), requestTimeoutMs: 100 });
    await timeout.adapter.resolveRepository(repository, "branch");
    await expect(timeout.adapter.readRef(repository, "main")).rejects.toMatchObject({ code: "GITHUB_TIMEOUT" });
  });

  it("does not follow API redirects and bounds malformed or oversized responses", async () => {
    const redirect = createAdapterFixture({ apiHandler: async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }) });
    await redirect.adapter.resolveRepository(repository, "branch");
    await expect(redirect.adapter.readRef(repository, "main")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    expect(redirect.calls.at(-1)?.init?.redirect).toBe("error");

    const malformed = createAdapterFixture({ apiHandler: async () => new Response("not-json", { status: 200 }) });
    await malformed.adapter.resolveRepository(repository, "branch");
    await expect(malformed.adapter.readRef(repository, "main")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });

    const oversized = createAdapterFixture({ apiHandler: async () => new Response("x".repeat(4 * 1024 * 1024 + 1), { status: 200 }) });
    await oversized.adapter.resolveRepository(repository, "branch");
    await expect(oversized.adapter.readRef(repository, "main")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });
});

function createAdapterFixture(options: {
  installationAppId?: number;
  installationStatus?: number;
  suspendedAt?: string | null;
  installationPermissions?: Record<string, string>;
  tokenPermissions?: Record<string, string>;
  tokenExpiresAt?: string;
  tokenRepositories?: Array<{ id: number; fullName: string }>;
  apiHandler?: (url: URL, init: RequestInit | undefined) => Promise<Response | undefined>;
  requestTimeoutMs?: number;
} = {}) {
  const calls: Array<{ url: URL; init: RequestInit | undefined; headers: Headers; body?: string }> = [];
  const fetcher = createFixtureFetcher(calls, options);
  const adapter = new RealGitHubAdapter(keys.credentials, {
    fetch: fetcher,
    now: () => now,
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  return { adapter, calls };
}

function createFixtureFetcher(
  calls: Array<{ url: URL; init: RequestInit | undefined; headers: Headers; body?: string }>,
  options: NonNullable<Parameters<typeof createAdapterFixture>[0]>,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === "string" ? init.body : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ url, init, headers, ...(body !== undefined ? { body } : {}) });
    const metadata = fixtureMetadataResponse(url, body, options);
    if (metadata) return metadata;
    const response = await options.apiHandler?.(url, init);
    return response ?? json({ message: "Not found" }, 404);
  };
}

function fixtureMetadataResponse(
  url: URL,
  body: string | undefined,
  options: NonNullable<Parameters<typeof createAdapterFixture>[0]>,
): Response | undefined {
  if (url.pathname === "/repos/CyanAutomation/demo-app/installation") {
    return json({
      id: 42,
      app_id: options.installationAppId ?? 3345400,
      account: { login: "CyanAutomation" },
      suspended_at: options.suspendedAt ?? null,
      permissions: options.installationPermissions ?? { metadata: "read", contents: "write", pull_requests: "write" },
    }, options.installationStatus ?? 200);
  }
  if (url.pathname === "/app/installations/42/access_tokens") {
    const request = body ? JSON.parse(body) as { permissions: Record<string, string> } : { permissions: {} };
    return json({
      token: "opaque-installation-token",
      expires_at: options.tokenExpiresAt ?? new Date(now + 3_600_000).toISOString(),
      permissions: options.tokenPermissions ?? { metadata: "read", ...request.permissions },
      repositories: options.tokenRepositories ?? [{ id: 77, full_name: "CyanAutomation/demo-app" }],
    }, 201);
  }
  if (url.pathname === "/repos/CyanAutomation/demo-app") {
    return json({ id: 77, full_name: "CyanAutomation/demo-app" });
  }
  return undefined;
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function pullRequestJson(number: number): Record<string, unknown> {
  return {
    number,
    html_url: `https://github.com/CyanAutomation/demo-app/pull/${number}`,
    state: "open",
    merged_at: null,
    title: `Test PR ${number}`,
    body: "",
    head: { ref: "kirisame/p/x", repo: { full_name: "CyanAutomation/demo-app" } },
    base: { ref: "main", repo: { full_name: "CyanAutomation/demo-app" } },
  };
}
