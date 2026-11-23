import { describe, expect, it } from "vitest";
import { semanticErrors } from "../../src/contracts/semantic.js";

const eventBase = {
  contractVersion: "1",
  eventId: "019a6000-0000-4000-8000-000000000004",
  publicationId: "019a6000-0000-7000-8000-000000000001",
  runId: "019a6000-0000-7000-8000-000000000002",
  occurredAt: "2026-11-20T10:00:00Z",
  source: "kirisame",
  type: "publication.branch_published",
  state: "publishing",
  repository: { owner: "cyanautomation", name: "demo-app" },
  branchRef: "kirisame/p/019a6000-0000-7000-8000-000000000001",
  commitSha: "d".repeat(40),
};

const branchResult = {
  contractVersion: "1",
  publicationId: "019a6000-0000-7000-8000-000000000001",
  runId: "019a6000-0000-7000-8000-000000000002",
  repository: { owner: "cyanautomation", name: "demo-app" },
  mode: "branch",
  outcome: "branch_published",
  retryable: false,
  reconciliation: "branch_confirmed",
  branch: { ref: "kirisame/p/019a6000-0000-7000-8000-000000000001", commitSha: "d".repeat(40) },
};

describe("publication semantic validation", () => {
  it("requires branch publication event details", async () => {
    const errors = await semanticErrors("publication-event", { ...eventBase, branchRef: undefined });

    expect(errors.map((error) => error.code)).toEqual(["INVALID_EVENT_PAYLOAD"]);
  });

  it("requires an error code for failure events", async () => {
    const errors = await semanticErrors("publication-event", {
      ...eventBase,
      type: "publication.retryable_failure",
      state: "retryable_failure",
      repository: undefined,
      branchRef: undefined,
      commitSha: undefined,
    });

    expect(errors.map((error) => error.code)).toEqual(["INVALID_EVENT_PAYLOAD"]);
  });

  it("checks event code taxonomy and classification against lifecycle state", async () => {
    const unknownCode = await semanticErrors("publication-event", { ...eventBase, errorCode: "UNKNOWN" });
    const mismatchedState = await semanticErrors("publication-event", {
      ...eventBase,
      type: "publication.blocked",
      state: "blocked",
      errorCode: "GITHUB_RATE_LIMITED",
    });

    expect(unknownCode.map((error) => error.code)).toEqual(["INVALID_EVENT_ERROR_CODE"]);
    expect(mismatchedState.map((error) => error.code)).toEqual(["INVALID_EVENT_ERROR_CLASSIFICATION"]);
  });

  it("validates the outcome-specific publication result requirements", async () => {
    const validBranch = await semanticErrors("publication-result", branchResult);
    const invalidBranch = await semanticErrors("publication-result", { ...branchResult, branch: undefined });
    const invalidPullRequest = await semanticErrors("publication-result", {
      ...branchResult,
      mode: "pr",
      outcome: "pr_published",
      pullRequest: { number: 42, url: "https://github.com/cyanautomation/demo-app/pull/42", state: "closed" },
    });
    const failedWithoutError = await semanticErrors("publication-result", {
      ...branchResult,
      outcome: "blocked",
      branch: undefined,
    });

    expect(validBranch).toEqual([]);
    expect(invalidBranch.map((error) => error.code)).toEqual(["MALFORMED_RESULT"]);
    expect(invalidPullRequest.map((error) => error.code)).toEqual(["MALFORMED_RESULT"]);
    expect(failedWithoutError.map((error) => error.code)).toEqual(["MALFORMED_RESULT"]);
  });
});
