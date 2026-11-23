import { describe, expect, it } from "vitest";
import branchFixture from "../contracts/valid/branch-publication-request.json";
import type { PublicationRequest } from "../../src/contracts/types.js";
import { utf8 } from "../../src/contracts/integrity.js";
import { MockGitHubAdapter } from "../../src/github/MockGitHubAdapter.js";
import { gitBlobSha } from "../../src/github/git-objects.js";

const repository = branchFixture.value.repository;

function makeRequest(): PublicationRequest {
  return structuredClone(branchFixture.value) as unknown as PublicationRequest;
}

describe("mock GitHub adapter tree updates", () => {
  it("replaces an entry and updates every ref to commits using the replaced tree", async () => {
    const request = makeRequest();
    const adapter = new MockGitHubAdapter();
    await adapter.seedForRequest(request);
    const base = await adapter.readCommit(repository, request.baseSha);
    expect(base).toBeDefined();
    const child = await adapter.createCommit(repository, {
      treeSha: base!.treeSha,
      parentSha: base!.sha,
      message: "second commit on base tree",
    });
    await adapter.createRef(repository, "feature", child.sha);

    const bytes = utf8("replacement contents\n");
    const blobSha = await gitBlobSha(bytes);
    await adapter.setBaseBlob(repository, blobSha, bytes);
    const replacementSha = await adapter.setBaseTreeEntry(repository, base!.treeSha, {
      path: "docs/guide.md",
      mode: "100644",
      type: "blob",
      sha: blobSha,
    });

    expect(replacementSha).not.toBe("");
    await expect(adapter.readRef(repository, request.baseRef)).resolves.toBe(replacementSha);
    const replacementChildSha = await adapter.readRef(repository, "feature");
    expect(replacementChildSha).toBeDefined();
    expect(replacementChildSha).not.toBe(child.sha);
    await expect(adapter.readCommit(repository, base!.sha)).resolves.toBeUndefined();
    const replacementCommit = await adapter.readCommit(repository, replacementSha);
    expect(replacementCommit?.treeSha).not.toBe(base!.treeSha);
    await expect(adapter.readCommit(repository, replacementChildSha!)).resolves.toMatchObject({
      treeSha: replacementCommit!.treeSha,
      message: child.message,
    });
    await expect(adapter.readTree(repository, replacementCommit!.treeSha)).resolves.toContainEqual({
      path: "docs/guide.md",
      mode: "100644",
      type: "blob",
      sha: blobSha,
    });
  });

  it("rejects unknown base trees and blob objects", async () => {
    const request = makeRequest();
    const adapter = new MockGitHubAdapter();
    await adapter.seedForRequest(request);
    const base = await adapter.readCommit(repository, request.baseSha);
    expect(base).toBeDefined();

    await expect(adapter.setBaseTreeEntry(repository, "f".repeat(40), {
      path: "new.txt", mode: "100644", type: "blob", sha: "a".repeat(40),
    })).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
    await expect(adapter.setBaseTreeEntry(repository, base!.treeSha, {
      path: "new.txt", mode: "100644", type: "blob", sha: "a".repeat(40),
    })).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  });
});

describe("mock GitHub adapter fault injection", () => {
  it("honors skipped calls and fault counts", async () => {
    const request = makeRequest();
    const adapter = new MockGitHubAdapter();
    await adapter.seedForRequest(request);
    adapter.injectFault("readRef", { code: "GITHUB_TIMEOUT", skip: 1, times: 2 });

    await expect(adapter.readRef(repository, request.baseRef)).resolves.toBe(request.baseSha);
    await expect(adapter.readRef(repository, request.baseRef)).rejects.toMatchObject({ code: "GITHUB_TIMEOUT" });
    await expect(adapter.readRef(repository, request.baseRef)).rejects.toMatchObject({ code: "GITHUB_TIMEOUT" });
    await expect(adapter.readRef(repository, request.baseRef)).resolves.toBe(request.baseSha);
  });

  it("distinguishes failures before and after a mutation", async () => {
    const request = makeRequest();
    const adapter = new MockGitHubAdapter();
    await adapter.seedForRequest(request);
    adapter.injectFault("createRef", { code: "GITHUB_TIMEOUT" });
    await expect(adapter.createRef(repository, "before-failure", request.baseSha))
      .rejects.toMatchObject({ code: "GITHUB_TIMEOUT" });
    await expect(adapter.readRef(repository, "before-failure")).resolves.toBeUndefined();

    adapter.injectFault("createRef", { code: "GITHUB_TIMEOUT", afterMutation: true });
    await expect(adapter.createRef(repository, "after-failure", request.baseSha))
      .rejects.toMatchObject({ code: "GITHUB_TIMEOUT" });
    await expect(adapter.readRef(repository, "after-failure")).resolves.toBe(request.baseSha);
  });
});
