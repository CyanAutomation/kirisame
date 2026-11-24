Warning: truncated output (original token count: 8299)
Total output lines: 725

import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import branchFixture from "../contracts/valid/branch-publication-request.json";
import prFixture from "../contracts/valid/pr-publication-request.json";
import type { CanaryAuthorizationResult, PublicationRequest, PublisherResponse } from "../../src/contracts/types.js";
import { canonicalizeJson } from "../../src/contracts/canonicalize.js";
import { bytesToBase64, sha256Hex, utf8 } from "../../src/contracts/integrity.js";
import { validateResultAgainstRequest } from "../../src/contracts/validate.js";
import { MockGitHubAdapter } from "../../src/github/MockGitHubAdapter.js";
import { gitBlobSha } from "../../src/github/git-objects.js";
import { AllowlistedPublicationPolicy } from "../../src/publication/policy.js";
import { PublicationService } from "../../src/publication/service.js";
import { PublisherEntrypoint } from "../../src/entrypoints/publisher.js";

interface TestPublisher {
  publish(requestJson: string): Promise<PublisherResponse>;
  reset(): Promise<void>;
  injectFault(operation: string, fault: { code: string; afterMutation?: boolean; retryAfterSeconds?: number; skip?: number; times?: number }): Promise<void>;
  moveBase(request: PublicationRequest, ref: string): Promise<string>;
  setPullRequestState(request: PublicationRequest, number: number, state: "open" | "closed" | "merged"): Promise<void>;
  operations(): Promise<string[]>;
}

const workerExports = exports as unknown as {
  default: typeof exports.default;
  PublisherEntrypoint: {
    publish(json: string): Promise<PublisherResponse>;
    verifyCanaryAuthorization(): Promise<CanaryAuthorizationResult>;
  };
  MockPublisherEntrypoint: TestPublisher;
};
const testPublisher = workerExports.MockPublisherEntrypoint;
let nextPublication = 1;

function makeRequest(mode: "branch" | "pr", publicationId?: string): PublicationRequest {
  const fixture = mode === "pr" ? prFixture.value : branchFixture.value;
  const request = structuredClone(fixture) as unknown as PublicationRequest;
  const id = publicationId ?? `019a6000-0000-7000-8000-${(nextPublication++).toString(16).padStart(12, "0")}`;
  request.publicationId = id;
  request.headRef = `kirisame/p/${id}`;
  return request;
}

async function harness(request: PublicationRequest) {
  const adapter = new MockGitHubAdapter();
  await adapter.seedForRequest(request);
  const service = new PublicationService(
    adapter,
    new AllowlistedPublicationPolicy([request.repository]),
  );
  return { adapter, service };
}

async function refreshRequest(request: PublicationRequest, baseSha?: string): Promise<void> {
  if (baseSha) {
    request.baseSha = baseSha;
    request.artifact.baseSha = baseSha;
  }
  request.artifact.fileCount = request.artifact.files.length;
  request.artifact.totalBytes = request.artifact.files.reduce(
    (total, file) => total + (file.operation === "delete" ? 0 : file.content.byteLength), 0,
  );
  const canonical = canonicalizeJson(request.artifact);
  if (canonical === undefined) throw new Error("fixture artifact did not canonicalize");
  request.artifactDigest = `sha256:${await sha256Hex(utf8(canonical))}`;
}

async function setContent(
  file: Exclude<PublicationRequest["artifact"]["files"][number], { operation: "delete" }>,
  value: string,
): Promise<void> {
  const bytes = utf8(value);
  file.content.data = bytesToBase64(bytes);
  file.content.byteLength = bytes.byteLength;
  file.content.sha256 = await sha256Hex(bytes);
}

async function seedAttributes(
  request: PublicationRequest,
  adapter: MockGitHubAdapter,
  path: string,
  text: string,
): Promise<void> {
  const base = await adapter.readCommit(request.repository, request.baseSha);
  if (!base) throw new Error("base commit fixture is missing");
  const bytes = utf8(text);
  const sha = await gitBlobSha(bytes);
  await adapter.setBaseBlob(request.repository, sha, bytes);
  const baseSha = await adapter.setBaseTreeEntry(request.repository, base.treeSha, {
    path,
    mode: "100644",
    type: "blob",
    sha,
  });
  await refreshRequest(request, baseSha);
}

afterEach(async () => {
  await testPublisher.reset();
});

describe("mock publication application", () => {
  it("creates a deterministic branch and returns a strictly valid branch result", async () => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    const result = await service.publish(request);

    expect(result.outcome).toBe("branch_published");
    expect(result.branch?.ref).toBe(`kirisame/p/${request.publicationId}`);
    expect(result.pullRequest).toBeUndefined();
    expect(adapter.count("createRef")).toBe(1);
    expect(await validateResultAgainstRequest(request, result)).toEqual([]);
  });

  it("reconciles identical PR requests without creating a duplicate branch or PR", async () => {
    const request = makeRequest("pr");
    const { adapter, service } = await harness(request);
    const first = await service.publish(request);
    const replay = await service.publish(request);

    expect(first.outcome).toBe("pr_published");
    expect(replay.outcome).toBe("pr_published");
    expect(adapter.count("createRef")).toBe(1);
    expect(adapter.count("createPullRequest")).toBe(1);
    expect(await validateResultAgainstRequest(request, replay)).toEqual([]);
  });

  it("preserves human title and description edits when the exact publication marker remains", async () => {
    const request = makeRequest("pr");
    const { adapter, service } = await harness(request);
    const first = await service.publish(request);
    const existing = (await adapter.listPullRequests(request.repository, request.headRef, request.baseRef))[0]!;
    const marker = existing.body.slice(existing.body.indexOf("Kirisame-Publication:"));
    const humanBody = `Reviewer context added by a maintainer.\n\n${marker}`;
    adapter.setPullRequestMetadata(request.repository, first.pullRequest!.number, {
      title: "A clearer title from a maintainer",
      body: humanBody,
    });

    const replay = await service.publish(request);

    expect(replay.outcome).toBe("pr_published");
    expect((await adapter.listPullRequests(request.repository, request.headRef, request.baseRef))[0])
      .toMatchObject({ title: "A clearer title from a maintainer", body: humanBody });
  });

  it.each([
    { label: "missing", edit: (body: string) => body.slice(0, body.indexOf("Kirisame-Publication:")).trimEnd() },
    { label: "altered", edit: (body: string) => body.replace("Kirisame-Artifact:", "Kirisame-Artifact-Changed:") },
    { label: "duplicated", edit: (body: string) => `${body}\n\nKirisame-Publication: an unrelated second marker` },
  ])("rejects a replay when the PR publication marker is $label", async ({ edit }) => {
    const request = makeRequest("pr");
    const { adapter, service } = await harness(request);
    const first = await service.publish(request);
    const existing = (await adapter.listPullRequests(request.repository, request.headRef, request.baseRef))[0]!;
    adapter.setPullRequestMetadata(request.repository, first.pullRequest!.number, {
      title: existing.title,
      body: edit(existing.body),
    });

    const replay = await service.publish(request);

    expect(replay.outcome).toBe("blocked");
    expect(replay.error?.code).toBe("PULL_REQUEST_CONFLICT");
  });

  it("blocks multiple PRs that match a publication head and base", async () => {
    const request = makeRequest("pr");
    const { adapter } = await harness(request);
    const service = new PublicationService(adapter, new AllowlistedPublicationPolicy([request.repository]));
    const first = await service.publish(request);
    expect(first.outcome).toBe("pr_published");

    const originalList = adapter.listPullRequests.bind(adapter);
    adapter.listPullRequests = async (repository, headRef, baseRef) => {
      const existing = await originalList(repository, headRef, baseRef);
      return existing.length ? [...existing, { ...existing[0]!, number: existing[0]!.number + 1 }] : existing;
    };
    const replay = await service.publish(request);

    expect(replay.outcome).toBe("blocked");
    expect(replay.error?.code).toBe("PULL_REQUEST_CONFLICT");
    expect(adapter.count("createPullRequest")).toBe(1);
  });

  it("recovers a lost branch-create response by reading the deterministic ref", async () => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    adapter.injectFault("createRef", { code: "GITHUB_TIMEOUT", afterMutation: true });
    const result = await service.publish(request);

    expect(result.outcome).toBe("branch_published");
    expect(result.branch?.reused).toBe(true);
    expect(adapter.count("createRef")).toBe(1);
  });

  it("preserves a ref-creation conflict when reconciliation finds no branch", async () => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    adapter.injectFault("createRef", { code: "BRANCH_CONFLICT" });

    const result = await service.publish(request);

    expect(result.outcome).toBe("blocked");
    expect(result.error?.code).toBe("BRANCH_CONFLICT");
    expect(await adapter.readRef(request.repository, request.headRef)).toBeUndefined();
  });

  it("recovers a lost PR-create response by listing the existing marked PR", async () => {
    const request = makeRequest("pr");
    const { adapter, service } = await harness(request);
    adapter.injectFault("createPullRequest", { code: "GITHUB_TIMEOUT", afterMutation: true });
    const result = await service.publish(request);

    expect(result.outcome).toBe("pr_published");
    expect(result.pullRequest?.state).toBe("open");
    expect(adapter.count("createPullRequest")).toBe(1);
    expect(adapter.count("listPullRequests")).toBe(2);
  });

  it("returns confirmed success after the target base advances", async () => {
    const request = makeRequest("pr");
    const …3299 tokens truncated…cts a file matched by a root Git LFS filter", async () => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    await seedAttributes(request, adapter, ".gitattributes", "*.md filter=lfs diff=lfs merge=lfs -text\n");

    const result = await service.publish(request);
    expect(result.error?.code).toBe("UNSUPPORTED_GIT_OBJECT");
    expect(adapter.count("createBlob")).toBe(0);
  });

  it("rejects a file matched by a nested Git LFS filter", async () => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    await seedAttributes(request, adapter, "docs/.gitattributes", "*.md filter=lfs\n");

    const result = await service.publish(request);
    expect(result.error?.code).toBe("UNSUPPORTED_GIT_OBJECT");
    expect(adapter.count("createBlob")).toBe(0);
  });

  it("allows changed text files outside the pinned LFS patterns", async () => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    await seedAttributes(request, adapter, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");

    const result = await service.publish(request);
    expect(result.outcome).toBe("branch_published");
    expect(adapter.count("createRef")).toBe(1);
  });

  it.each([
    "**/*.bin filter=lfs\n",
    "*.md working-tree-encoding=UTF-16\n",
  ])("fails closed on unsupported Git attributes config %s", async (attributes) => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    await seedAttributes(request, adapter, ".gitattributes", attributes);

    const result = await service.publish(request);
    expect(result.error?.code).toBe("UNSUPPORTED_GIT_OBJECT");
    expect(adapter.count("createBlob")).toBe(0);
  });

  it("rejects artifact digest tampering before any adapter operation", async () => {
    const request = makeRequest("branch");
    request.artifactDigest = `sha256:${"0".repeat(64)}`;
    const { adapter, service } = await harness(request);

    await expect(service.publish(request)).rejects.toMatchObject({ code: "ARTIFACT_DIGEST_MISMATCH" });
    expect(adapter.operations).toEqual([]);
  });
});

describe("private and public Worker entrypoints", () => {
  it("serves only the public liveness and readiness routes", async () => {
    const root = await workerExports.default.fetch(new Request("https://kirisame.test/"));
    const health = await workerExports.default.fetch(new Request("https://kirisame.test/health"));
    const ready = await workerExports.default.fetch(new Request("https://kirisame.test/readyz"));

    expect(root.status).toBe(200);
    expect(await root.json()).toMatchObject({
      service: "kirisame",
      implementation: "github-app-publisher",
      publishing: "unavailable",
      version: { sourceCommit: "unknown", application: "unknown", contract: "unknown", builtAt: "unknown" },
    });
    expect(health.status).toBe(200);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "not_ready", publishing: "unavailable" });
  });

  it.each([
    { path: "/", method: "POST" },
    { path: "/health", method: "POST" },
    { path: "/readyz", method: "POST" },
  ])("rejects public $method $path diagnostics requests", async ({ path, method }) => {
    const response = await workerExports.default.fetch(new Request(`https://kirisame.test${path}`, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(await response.json()).toEqual({ code: "METHOD_NOT_ALLOWED", message: "Method not allowed" });
  });

  it.each(["GET", "POST", "OPTIONS"])("does not route public %s requests to the publisher", async (method) => {
    const response = await workerExports.default.fetch(new Request("https://kirisame.test/internal/v1/publications", {
      method,
      headers: { authorization: "Bearer forged", "x-soyuz-service": "trusted" },
      ...(method === "POST" ? { body: "{}" } : {}),
    }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "NOT_FOUND", message: "Not found" });
  });

  it("uses the trusted test-only named publisher entrypoint for mock publication", async () => {
    const request = makeRequest("branch");
    const result = await testPublisher.publish(JSON.stringify(request));

    if (!("outcome" in result)) throw new Error("expected publication result");
    expect(result.outcome).toBe("branch_published");
  });

  it("publishes a PR through the trusted test-only named entrypoint", async () => {
    const request = makeRequest("pr");
    const result = await testPublisher.publish(JSON.stringify(request));

    if (!("outcome" in result)) throw new Error("expected publication result");
    expect(result.outcome).toBe("pr_published");
    expect(result.pullRequest?.state).toBe("open");
    expect(await validateResultAgainstRequest(request, result)).toEqual([]);
  });

  it("keeps a branch without a PR as retryable partial progress", async () => {
    const request = makeRequest("pr");
    await testPublisher.injectFault("listPullRequests", { code: "GITHUB_RATE_LIMITED", retryAfterSeconds: 30 });
    const result = await testPublisher.publish(JSON.stringify(request));

    if (!("outcome" in result)) throw new Error("expected publication result");
    expect(result.outcome).toBe("retryable_failure");
    expect(result.branch?.ref).toBe(request.headRef);
    expect(result.pullRequest).toBeUndefined();
    expect(await validateResultAgainstRequest(request, result)).toEqual([]);
  });

  it("rejects an invalid request before the trusted test binding calls the adapter", async () => {
    const request = makeRequest("branch");
    delete (request as Partial<PublicationRequest>).mode;
    const response = await testPublisher.publish(JSON.stringify(request));

    expect("code" in response && response.code).toBe("INVALID_REQUEST");
    expect(await testPublisher.operations()).toEqual([]);
  });

  it("rejects malformed JSON before the trusted test binding calls the adapter", async () => {
    const response = await testPublisher.publish("{");

    expect("code" in response && response.code).toBe("INVALID_REQUEST");
    expect(await testPublisher.operations()).toEqual([]);
  });

  it("maps unsupported contract versions to the version error", async () => {
    const request = makeRequest("branch");
    (request as { contractVersion: string }).contractVersion = "2";
    const response = await testPublisher.publish(JSON.stringify(request));

    expect("code" in response && response.code).toBe("UNSUPPORTED_VERSION");
    expect(await testPublisher.operations()).toEqual([]);
  });

  it("rejects an unsupported publication operation before adapter calls", async () => {
    const request = makeRequest("branch");
    (request as { mode: string }).mode = "merge";
    const result = await testPublisher.publish(JSON.stringify(request));

    expect("code" in result && result.code).toBe("INVALID_REQUEST");
    expect(await testPublisher.operations()).toEqual([]);
  });

  it("classifies an unavailable GitHub service as retryable through RPC", async () => {
    const request = makeRequest("branch");
    await testPublisher.injectFault("resolveRepository", { code: "GITHUB_UNAVAILABLE" });
    const result = await testPublisher.publish(JSON.stringify(request));

    if (!("outcome" in result)) throw new Error("expected publication result");
    expect(result.outcome).toBe("retryable_failure");
    expect(result.error?.code).toBe("GITHUB_UNAVAILABLE");
    expect(await validateResultAgainstRequest(request, result)).toEqual([]);
  });

  it("returns an explicit unavailable response from the production private entrypoint", async () => {
    const request = makeRequest("pr");
    const result = await workerExports.PublisherEntrypoint.publish(JSON.stringify(request));

    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) throw new Error("expected publication result");
    expect(result.outcome).toBe("blocked");
    expect(result.error?.code).toBe("PUBLISHING_UNAVAILABLE");
    expect(result.pullRequest).toBeUndefined();
    expect(await validateResultAgainstRequest(request, result)).toEqual([]);
  });

  it("exposes a read-only fixed-repository preflight while publishing stays disabled", async () => {
    await expect(workerExports.PublisherEntrypoint.verifyCanaryAuthorization()).resolves.toEqual({
      status: "rejected",
      code: "PUBLISHING_UNAVAILABLE",
      failureStage: "configuration",
    });
  });

  it("maps preflight failures to a safe result without returning the key", async () => {
    const secret = "private-key-value-must-not-escape";
    const publisher = Object.create(PublisherEntrypoint.prototype) as PublisherEntrypoint;
    Object.defineProperty(publisher, "env", {
      value: { PUBLISHING_ENABLED: "false", GITHUB_APP_ID: "3345400", GITHUB_APP_PRIVATE_KEY: secret },
    });

    const result = await publisher.verifyCanaryAuthorization();

    expect(result).toEqual({
      status: "rejected",
      code: "PUBLISHING_UNAVAILABLE",
      failureStage: "private_key_pem_envelope",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("bounds raw RPC payloads before parsing", async () => {
    const tooLarge = await testPublisher.publish("x".repeat(9 * 1024 * 1024 + 1));
    expect("code" in tooLarge && tooLarge.code).toBe("ARTIFACT_INVALID");
  });

  it("maps nested artifact digest failures to a structured invalid response", async () => {
    const request = makeRequest("branch");
    request.artifactDigest = `sha256:${"0".repeat(64)}`;
    const body = await testPublisher.publish(JSON.stringify(request));

    expect("code" in body && body.code).toBe("ARTIFACT_DIGEST_MISMATCH");
    expect("classification" in body && body.classification).toBe("invalid");
    expect(await testPublisher.operations()).toEqual([]);
  });
});
