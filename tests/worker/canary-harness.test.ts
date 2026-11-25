import { beforeAll, describe, expect, it } from "vitest";
import branchPublicationRequest from "../contracts/valid/branch-publication-request.json";
import publicationRequest from "../contracts/valid/pr-publication-request.json";
import publicationResult from "../contracts/valid/successful-pr-result.json";
import type { PublicationRequest, PublisherResponse } from "../../src/contracts/types.js";
import { canonicalizeJson } from "../../src/contracts/canonicalize.js";
import { sha256Hex, utf8 } from "../../src/contracts/integrity.js";
import { validateContract } from "../../src/contracts/validate.js";
import { handleCanaryRequest } from "../../src/canary/harness.js";
import { MAX_REQUEST_BODY_BYTES } from "../../src/entrypoints/publisher.js";

let requestJson: string;
const enabled = {
  KIRISAME_CANARY_ENABLED: "true",
  KIRISAME_CANARY_REPOSITORY: "CyanAutomation/somatic",
  KIRISAME_CANARY_BASE_REF: "main",
  KIRISAME_CALLER_ID: "kirisame-canary-harness",
  KIRISAME_API_KEY: "A".repeat(43),
};

beforeAll(async () => {
  requestJson = await makeCanaryRequest(publicationRequest.value as unknown as PublicationRequest);
});

describe("private canary harness", () => {
  it("calls the named publisher entrypoint twice with the identical authorized request", async () => {
    const calls: Array<[string, string, string]> = [];
    const publisher = {
      publish: async (value: string, callerId: string, apiKey: string): Promise<PublisherResponse> => {
        calls.push([value, callerId, apiKey]);
        return publicationResult.value as PublisherResponse;
      },
    };
    const response = await handleCanaryRequest(localRequest(requestJson), { ...enabled, KIRISAME: publisher });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      [requestJson, "kirisame-canary-harness", "A".repeat(43)],
      [requestJson, "kirisame-canary-harness", "A".repeat(43)],
    ]);
    expect(await response.json()).toMatchObject({
      first: { outcome: "pr_published" },
      replay: { outcome: "pr_published" },
    });
  });

  it("preserves a confirmed first publication when the replay call throws", async () => {
    let calls = 0;
    const publisher = {
      publish: async (): Promise<PublisherResponse> => {
        calls += 1;
        if (calls === 2) throw new Error("replay response lost");
        return publicationResult.value as PublisherResponse;
      },
    };

    const response = await handleCanaryRequest(localRequest(requestJson), { ...enabled, KIRISAME: publisher });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      first: { outcome: "pr_published" },
      replay: null,
    });
  });

  it("enforces the request byte limit while streaming", async () => {
    let called = false;
    const response = await handleCanaryRequest(
      localRequest("x".repeat(MAX_REQUEST_BODY_BYTES + 1)),
      { ...enabled, KIRISAME: { publish: async () => { called = true; return publicationResult.value as PublisherResponse; } } },
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it("does not invoke the publisher for non-loopback requests", async () => {
    let called = false;
    const response = await handleCanaryRequest(
      new Request("https://kirisame-canary-harness.workers.dev/__canary/publish-replay", { method: "POST", body: requestJson }),
      { ...enabled, KIRISAME: { publish: async () => { called = true; return publicationResult.value as PublisherResponse; } } },
    );

    expect(response.status).toBe(404);
    expect(called).toBe(false);
  });

  it("enforces the one configured repository and base branch", async () => {
    let called = false;
    const response = await handleCanaryRequest(
      localRequest(requestJson),
      { ...enabled, KIRISAME_CANARY_REPOSITORY: "cyanautomation/another-repository", KIRISAME: { publish: async () => { called = true; return publicationResult.value as PublisherResponse; } } },
    );

    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });

  it("rejects branch mode and a non-main base before calling the publisher", async () => {
    for (const request of [
      await makeCanaryRequest(branchPublicationRequest.value as unknown as PublicationRequest),
      await makeCanaryRequest(publicationRequest.value as unknown as PublicationRequest, { baseRef: "release" }),
    ]) {
      let called = false;
      const response = await handleCanaryRequest(localRequest(request), {
        ...enabled,
      KIRISAME: { publish: async () => { called = true; return publicationResult.value as PublisherResponse; } },
      });

      expect(response.status).toBe(403);
      expect(called).toBe(false);
    }
  });

  it("fails closed when the private publisher binding is not available", async () => {
    const response = await handleCanaryRequest(localRequest(requestJson), enabled);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "CANARY_UNAVAILABLE" });
  });

  it("fails closed when the caller API key is missing", async () => {
    let called = false;
    const response = await handleCanaryRequest(localRequest(requestJson), {
      ...enabled,
      KIRISAME_API_KEY: undefined,
      KIRISAME: { publish: async () => { called = true; return publicationResult.value as PublisherResponse; } },
    });

    expect(response.status).toBe(503);
    expect(called).toBe(false);
  });

  it("rejects malformed JSON before calling the publisher", async () => {
    let called = false;
    const response = await handleCanaryRequest(
      localRequest("{"),
      { ...enabled, KIRISAME: { publish: async () => { called = true; return publicationResult.value as PublisherResponse; } } },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(called).toBe(false);
  });

  it("returns one result without replay when the first publication is not confirmed", async () => {
    const first = { code: "GITHUB_UNAVAILABLE", classification: "retryable", message: "Retry later." } as PublisherResponse;
    let calls = 0;
    const response = await handleCanaryRequest(localRequest(requestJson), {
      ...enabled,
      KIRISAME: { publish: async () => { calls += 1; return first; } },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ first, replay: null });
    expect(calls).toBe(1);
  });
});

function localRequest(body: string): Request {
  return new Request("http://127.0.0.1:5173/__canary/publish-replay", { method: "POST", body });
}

async function makeCanaryRequest(
  source: PublicationRequest,
  overrides: { baseRef?: string } = {},
): Promise<string> {
  const request = structuredClone(source);
  const repository = { owner: "cyanautomation", name: "somatic" };
  request.repository = repository;
  request.artifact.repository = repository;
  if (overrides.baseRef) {
    request.baseRef = overrides.baseRef;
    request.artifact.baseRef = overrides.baseRef;
  }
  const canonical = canonicalizeJson(request.artifact);
  if (canonical === undefined) throw new Error("canary test artifact did not canonicalize");
  request.artifactDigest = `sha256:${await sha256Hex(utf8(canonical))}`;
  const validation = await validateContract("publication-request", request);
  if (!validation.valid) throw new Error(JSON.stringify(validation.errors));
  return JSON.stringify(request);
}
