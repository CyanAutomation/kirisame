import { describe, expect, it } from "vitest";
import publicationRequest from "../contracts/valid/pr-publication-request.json";
import publicationResult from "../contracts/valid/successful-pr-result.json";
import type { PublisherResponse } from "../../src/contracts/types.js";
import { handleCanaryRequest } from "../../src/canary/harness.js";
import { MAX_REQUEST_BODY_BYTES } from "../../src/entrypoints/publisher.js";

const requestJson = JSON.stringify(publicationRequest.value);
const enabled = {
  KIRISAME_CANARY_ENABLED: "true",
  KIRISAME_CANARY_REPOSITORY: "cyanautomation/demo-app",
  KIRISAME_CANARY_BASE_REF: "main",
};

describe("private canary harness", () => {
  it("calls the named publisher entrypoint twice with the identical authorized request", async () => {
    const calls: string[] = [];
    const publisher = {
      publish: async (value: string): Promise<PublisherResponse> => {
        calls.push(value);
        return publicationResult.value as PublisherResponse;
      },
    };
    const response = await handleCanaryRequest(localRequest(requestJson), { ...enabled, KIRISAME: publisher });

    expect(response.status).toBe(200);
    expect(calls).toEqual([requestJson, requestJson]);
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

  it("fails closed when the private publisher binding is not available", async () => {
    const response = await handleCanaryRequest(localRequest(requestJson), enabled);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "CANARY_UNAVAILABLE" });
  });
});

function localRequest(body: string): Request {
  return new Request("http://127.0.0.1:5173/__canary/publish-replay", { method: "POST", body });
}
