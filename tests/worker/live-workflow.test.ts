import { beforeAll, describe, expect, it, vi } from "vitest";
import publicationRequest from "../contracts/valid/pr-publication-request.json";
import publicationResult from "../contracts/valid/successful-pr-result.json";
import type { PublicationRequest, PublicationResult, PublisherResponse, Repository } from "../../src/contracts/types.js";
import { canonicalizeJson } from "../../src/contracts/canonicalize.js";
import { bytesToBase64, sha256Hex, utf8 } from "../../src/contracts/integrity.js";
import { validateContract } from "../../src/contracts/validate.js";
import liveCanaryWorker, {
  LiveCanaryWorkflow,
  runLiveCanary,
  runLiveCanaryAllowlistProbe,
  runLiveCanaryPreflight,
} from "../../src/canary/live-workflow.js";
import { CANARY_PUBLICATION_TARGET } from "../../src/shared/canary-target.js";
import { PublicationFailure } from "../../src/errors/publication-error.js";

const TEST_CONTENT = "Kirisame live integration test.\n";
const TEST_PATH = "kirisame-canary/verification.txt";
let requestJson: string;

beforeAll(async () => {
  requestJson = await makeCanaryRequest();
});

describe("deployed live canary workflow", () => {
  it("has no HTTP publishing route even if a request reaches the worker", async () => {
    const response = liveCanaryWorker.fetch(new Request("https://kirisame-live-invoker.example/__canary/publish-replay"));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("dispatches deployed Workflow actions through the private publisher binding", async () => {
    const probeRequest = await makeCanaryRequest({ owner: "cyanautomation", name: "kirisame-policy-probe-never-create" });
    const denial: PublicationResult = {
      contractVersion: "1",
      publicationId: "019a6000-0000-7000-8000-000000000001",
      runId: "019a6000-0000-7000-8000-000000000002",
      repository: { owner: "cyanautomation", name: "kirisame-policy-probe-never-create" },
      mode: "pr",
      outcome: "blocked",
      retryable: false,
      reconciliation: "not_needed",
      error: new PublicationFailure("REPOSITORY_NOT_ALLOWED").toContractError(),
    };
    const publisher = {
      publish: vi.fn(async (value: string): Promise<PublisherResponse> =>
        value === probeRequest ? denial : liveResult()),
      verifyCanaryAuthorization: vi.fn(async () => ({ status: "verified" as const, repository: "CyanAutomation/somatic" as const })),
    };
    const workflow = Object.create(LiveCanaryWorkflow.prototype) as LiveCanaryWorkflow;
    Object.defineProperty(workflow, "env", { value: { KIRISAME: publisher } });
    const step = directStep as Parameters<LiveCanaryWorkflow["run"]>[1];
    const invoke = (payload: unknown) => workflow.run({ payload } as Parameters<LiveCanaryWorkflow["run"]>[0], step);

    await expect(invoke({ action: "preflight" })).resolves.toMatchObject({ status: "verified" });
    await expect(invoke({ action: "allowlist-probe", requestJson: probeRequest })).resolves.toMatchObject({
      status: "confirmed-denial",
      response: { error: { code: "REPOSITORY_NOT_ALLOWED" } },
    });
    await expect(invoke({ action: "unsupported", requestJson: requestJson } as unknown)).resolves.toEqual({
      status: "rejected",
      code: "CANARY_INVALID_REQUEST",
    });
    await expect(invoke({ action: "publish", requestJson })).resolves.toMatchObject({
      status: "completed",
      first: { outcome: "pr_published" },
      replay: { outcome: "pr_published" },
    });
    expect(publisher.publish).toHaveBeenCalledTimes(3);
    expect(publisher.verifyCanaryAuthorization).toHaveBeenCalledOnce();
  });

  it("runs the fixed GitHub App preflight without invoking publication", async () => {
    const preflight = { status: "verified", repository: "CyanAutomation/somatic" } as const;
    const publisher = {
      publish: vi.fn(async (): Promise<PublisherResponse> => liveResult()),
      verifyCanaryAuthorization: vi.fn(async () => preflight),
    };

    await expect(runLiveCanaryPreflight(publisher, directStep)).resolves.toEqual(preflight);
    expect(publisher.verifyCanaryAuthorization).toHaveBeenCalledOnce();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("parses JSON-encoded REST API instance parameters as the workflow payload", async () => {
    const preflight = { status: "verified", repository: "CyanAutomation/somatic" } as const;
    const publisher = {
      publish: vi.fn(async (): Promise<PublisherResponse> => liveResult()),
      verifyCanaryAuthorization: vi.fn(async () => preflight),
    };
    const workflow = Object.create(LiveCanaryWorkflow.prototype) as LiveCanaryWorkflow;
    Object.defineProperty(workflow, "env", { value: { KIRISAME: publisher } });
    const event = { payload: JSON.stringify({ action: "preflight", requestJson: "" }) };

    await expect(workflow.run(
      event as unknown as Parameters<LiveCanaryWorkflow["run"]>[0],
      directStep as Parameters<LiveCanaryWorkflow["run"]>[1],
    ))
      .resolves.toEqual(preflight);
    expect(publisher.verifyCanaryAuthorization).toHaveBeenCalledOnce();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("confirms the production allowlist rejects one fixed nonexistent repository", async () => {
    const request = await makeCanaryRequest({ owner: "cyanautomation", name: "kirisame-policy-probe-never-create" });
    const denial = {
      contractVersion: "1" as const,
      publicationId: "019a6000-0000-7000-8000-000000000001",
      runId: "019a6000-0000-7000-8000-000000000002",
      repository: { owner: "CyanAutomation", name: "kirisame-policy-probe-never-create" },
      mode: "pr" as const,
      outcome: "blocked" as const,
      retryable: false,
      reconciliation: "not_needed" as const,
      error: new PublicationFailure("REPOSITORY_NOT_ALLOWED").toContractError(),
    };
    const publisher = { publish: vi.fn(async () => denial) };

    await expect(runLiveCanaryAllowlistProbe(request, publisher, directStep)).resolves.toMatchObject({
      status: "confirmed-denial",
      response: { outcome: "blocked", error: { code: "REPOSITORY_NOT_ALLOWED" } },
    });
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("sends one exact approved Somatic PR request twice and preserves both results", async () => {
    const calls: string[] = [];
    const publisher = {
      publish: vi.fn(async (value: string): Promise<PublisherResponse> => {
        calls.push(value);
        return liveResult();
      }),
    };
    const result = await runLiveCanary(requestJson, publisher, directStep);

    expect(result).toMatchObject({
      status: "completed",
      first: { outcome: "pr_published", pullRequest: { state: "open", number: 42 } },
      replay: { outcome: "pr_published", pullRequest: { state: "open", number: 42 } },
    });
    expect(calls).toEqual([requestJson, requestJson]);
  });

  it("disables automatic retries for both side-effecting publisher calls", async () => {
    const configs: unknown[] = [];
    const step = {
      do: async <T>(_name: string, config: unknown, callback: () => Promise<T>): Promise<T> => {
        configs.push(config);
        return callback();
      },
    };
    const publisher = { publish: vi.fn(async (): Promise<PublisherResponse> => liveResult()) };

    await runLiveCanary(requestJson, publisher, step);

    expect(configs).toEqual([
      { retries: { limit: 0, delay: "1 second" } },
      { retries: { limit: 0, delay: "1 second" } },
    ]);
  });

  it("retains the first confirmed result when the replay binding call fails", async () => {
    const publisher = {
      publish: vi.fn()
        .mockResolvedValueOnce(liveResult())
        .mockRejectedValueOnce(new Error("replay response lost")),
    };
    const result = await runLiveCanary(requestJson, publisher, directStep);

    expect(result).toMatchObject({
      status: "completed",
      first: { outcome: "pr_published", pullRequest: { state: "open", number: 42 } },
      replay: null,
    });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(publisher.publish).toHaveBeenNthCalledWith(1, requestJson);
    expect(publisher.publish).toHaveBeenNthCalledWith(2, requestJson);
  });

  it("does not replay a result unless the first call confirms an open PR and commit", async () => {
    const confirmed = liveResult();
    const first = { ...confirmed, pullRequest: { ...confirmed.pullRequest!, state: "closed" as const } };
    const publisher = { publish: vi.fn(async (): Promise<PublisherResponse> => first) };

    const result = await runLiveCanary(requestJson, publisher, directStep);

    expect(result).toEqual({ status: "completed", first, replay: null });
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it("rejects a valid request outside the one repository before calling the publisher", async () => {
    const outOfScope = await makeCanaryRequest({ owner: "cyanautomation", name: "another-repo" });
    const publisher = { publish: vi.fn(async (): Promise<PublisherResponse> => liveResult()) };

    const result = await runLiveCanary(outOfScope, publisher, directStep);

    expect(result).toEqual({ status: "rejected", code: "CANARY_POLICY_DENIED" });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized workflow payloads without calling the publisher", async () => {
    const publisher = { publish: vi.fn(async (): Promise<PublisherResponse> => liveResult()) };

    expect(await runLiveCanary("{", publisher, directStep)).toEqual({
      status: "rejected",
      code: "CANARY_INVALID_REQUEST",
    });
    expect(await runLiveCanary("x".repeat(9 * 1024 * 1024 + 1), publisher, directStep)).toEqual({
      status: "rejected",
      code: "CANARY_INVALID_REQUEST",
    });
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});

const directStep = {
  do: async <T>(_name: string, _config: unknown, callback: () => Promise<T>): Promise<T> => callback(),
};

function liveResult(): PublicationResult {
  return {
    ...(publicationResult.value as PublicationResult),
    repository: { owner: CANARY_PUBLICATION_TARGET.owner, name: CANARY_PUBLICATION_TARGET.repository },
    branch: {
      ref: "kirisame/p/019a6000-0000-7000-8000-000000000001",
      commitSha: "dddddddddddddddddddddddddddddddddddddddd",
    },
    pullRequest: {
      number: 42,
      url: "https://github.com/CyanAutomation/somatic/pull/42",
      state: "open",
    },
  };
}

async function makeCanaryRequest(repository: Repository = {
  owner: CANARY_PUBLICATION_TARGET.owner.toLowerCase(),
  name: CANARY_PUBLICATION_TARGET.repository,
}): Promise<string> {
  const request = structuredClone(publicationRequest.value) as unknown as PublicationRequest;
  request.repository = repository;
  request.mode = "pr";
  request.baseRef = CANARY_PUBLICATION_TARGET.baseRef;
  request.baseSha = "0d02873b71256892b4ec8026a3b0e2a5ab6aaa91";
  request.headRef = "kirisame/p/" + request.publicationId;
  request.title = "test: verify Kirisame GitHub App publication";
  request.body = "Controlled integration test of Kirisame's GitHub App authentication, branch creation, PR publication and idempotent replay.";
  request.artifact.repository = repository;
  request.artifact.baseRef = request.baseRef;
  request.artifact.baseSha = request.baseSha;
  const contentBytes = utf8(TEST_CONTENT);
  request.artifact.fileCount = 1;
  request.artifact.totalBytes = contentBytes.byteLength;
  request.artifact.files = [{
    operation: "add",
    path: TEST_PATH,
    content: {
      mediaType: "text/plain; charset=utf-8",
      encoding: "base64",
      byteLength: contentBytes.byteLength,
      sha256: await sha256Hex(contentBytes),
      data: bytesToBase64(contentBytes),
    },
  }];
  const canonicalArtifact = canonicalizeJson(request.artifact);
  if (canonicalArtifact === undefined) throw new Error("test artifact did not canonicalize");
  request.artifactDigest = "sha256:" + await sha256Hex(utf8(canonicalArtifact));
  const validation = await validateContract("publication-request", request);
  if (!validation.valid) throw new Error(JSON.stringify(validation.errors));
  return JSON.stringify(request);
}
