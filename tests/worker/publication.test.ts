import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import branchFixture from "../contracts/valid/branch-publication-request.json";
import prFixture from "../contracts/valid/pr-publication-request.json";
import type { PublicationRequest, PublisherResponse } from "../../src/contracts/types.js";
import { validateResultAgainstRequest } from "../../src/contracts/validate.js";
import { MockGitHubAdapter } from "../../src/github/MockGitHubAdapter.js";
import { AllowlistedPublicationPolicy } from "../../src/publication/policy.js";
import { PublicationService } from "../../src/publication/service.js";

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
  PublisherEntrypoint: { publish(json: string): Promise<PublisherResponse> };
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

  it("recovers a lost branch-create response by reading the deterministic ref", async () => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    adapter.injectFault("createRef", { code: "GITHUB_TIMEOUT", afterMutation: true });
    const result = await service.publish(request);

    expect(result.outcome).toBe("branch_published");
    expect(result.branch?.reused).toBe(true);
    expect(adapter.count("createRef")).toBe(1);
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
    const { adapter, service } = await harness(request);
    expect((await service.publish(request)).outcome).toBe("pr_published");
    const readsBeforeReplay = adapter.count("readRef");
    await adapter.moveBase(request.repository, request.baseRef);

    const replay = await service.publish(request);
    expect(replay.outcome).toBe("pr_published");
    expect(adapter.count("readRef")).toBe(readsBeforeReplay + 1);
  });

  it("rejects base movement before the first write", async () => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    await adapter.moveBase(request.repository, request.baseRef);
    const result = await service.publish(request);

    expect(result.outcome).toBe("blocked");
    expect(result.error?.code).toBe("BASE_MOVED");
    expect(adapter.count("createBlob")).toBe(0);
    expect(adapter.count("createRef")).toBe(0);
  });

  it("completes a valid existing branch whose PR was not created", async () => {
    const branchRequest = makeRequest("branch");
    const { adapter, service } = await harness(branchRequest);
    expect((await service.publish(branchRequest)).outcome).toBe("branch_published");
    const prRequest = makeRequest("pr", branchRequest.publicationId);

    const result = await service.publish(prRequest);
    expect(result.outcome).toBe("pr_published");
    expect(result.branch?.reused).toBe(true);
    expect(adapter.count("createRef")).toBe(1);
  });

  it("blocks an unrelated deterministic branch without overwriting it", async () => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    await adapter.addExistingBranch(request.repository, request.headRef, request.baseSha);
    const result = await service.publish(request);

    expect(result.outcome).toBe("blocked");
    expect(result.error?.code).toBe("BRANCH_CONFLICT");
    expect(adapter.count("createRef")).toBe(0);
  });

  it("blocks a closed or merged matching PR on replay", async () => {
    const request = makeRequest("pr");
    const { adapter, service } = await harness(request);
    const first = await service.publish(request);
    await adapter.setPullRequestState(request.repository, first.pullRequest!.number, "merged");

    const replay = await service.publish(request);
    expect(replay.outcome).toBe("blocked");
    expect(replay.error?.code).toBe("PULL_REQUEST_CONFLICT");
    expect(adapter.count("createPullRequest")).toBe(1);
  });

  it("keeps an uncertain publication retryable when a reconciliation read fails", async () => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    adapter.injectFault("createRef", { code: "GITHUB_TIMEOUT", afterMutation: true });
    adapter.injectFault("readRef", { code: "GITHUB_TIMEOUT", skip: 2 });
    const uncertain = await service.publish(request);

    expect(uncertain.outcome).toBe("retryable_failure");
    expect(uncertain.reconciliation).toBe("unknown");
    expect(uncertain.error?.code).toBe("GITHUB_TIMEOUT");
    expect((await service.publish(request)).outcome).toBe("branch_published");
  });

  it("classifies GitHub rate limits with a bounded retry delay", async () => {
    const request = makeRequest("pr");
    const { adapter, service } = await harness(request);
    adapter.injectFault("listPullRequests", { code: "GITHUB_RATE_LIMITED", retryAfterSeconds: 45 });
    const result = await service.publish(request);

    expect(result.outcome).toBe("retryable_failure");
    expect(result.retryable).toBe(true);
    expect(result.branch?.ref).toBe(request.headRef);
    expect(result.error?.retryAfterSeconds).toBe(45);
  });

  it("uses create-only refs safely for concurrent duplicate calls", async () => {
    const request = makeRequest("pr");
    const { adapter, service } = await harness(request);
    const results = await Promise.all([service.publish(request), service.publish(request)]);

    expect(results.map((result) => result.outcome)).toEqual(["pr_published", "pr_published"]);
    expect(adapter.count("createRef")).toBe(2);
    expect(adapter.count("createPullRequest")).toBe(2);
  });

  it.each([
    { mode: "120000", type: "blob", label: "symlink" },
    { mode: "100755", type: "blob", label: "executable file" },
    { mode: "160000", type: "commit", label: "submodule gitlink" },
  ])("rejects a $label in the base tree", async ({ mode, type }) => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    const base = await adapter.readCommit(request.repository, request.baseSha);
    await adapter.setBaseTreeEntry(request.repository, base!.treeSha, {
      path: "docs/guide.md",
      mode,
      type,
      sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });
    const result = await service.publish(request);

    expect(result.error?.code).toBe("UNSUPPORTED_GIT_OBJECT");
    expect(adapter.count("createBlob")).toBe(0);
  });

  it("rejects Git LFS pointers and binary base content before writing", async () => {
    const request = makeRequest("branch");
    const change = request.artifact.files.find((file) => file.operation === "modify");
    expect(change?.operation).toBe("modify");
    if (change?.operation !== "modify") throw new Error("expected modify fixture");
    const { adapter, service } = await harness(request);
    adapter.setBaseBlob(request.repository, change.baseBlobSha, new TextEncoder().encode("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 5\n"));

    const lfs = await service.publish(request);
    expect(lfs.error?.code).toBe("UNSUPPORTED_GIT_OBJECT");
    expect(adapter.count("createBlob")).toBe(0);
  });

  it("rejects attempts to add a regular file over a base-tree directory", async () => {
    const request = makeRequest("branch");
    const { adapter, service } = await harness(request);
    const base = await adapter.readCommit(request.repository, request.baseSha);
    await adapter.setBaseTreeEntry(request.repository, base!.treeSha, {
      path: "README.md",
      mode: "040000",
      type: "tree",
      sha: "ffffffffffffffffffffffffffffffffffffffff",
    });

    const result = await service.publish(request);
    expect(result.error?.code).toBe("BASE_TREE_CONFLICT");
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
    expect(await root.json()).toEqual({ service: "kirisame", implementation: "worker-foundation", publishing: "unavailable" });
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
