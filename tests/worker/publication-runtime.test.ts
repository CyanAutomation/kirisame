import { describe, expect, it } from "vitest";
import { PublicationFailure } from "../../src/errors/publication-error.js";
import { RealGitHubAdapter } from "../../src/github/RealGitHubAdapter.js";
import { createProductionPublicationService, isProductionPublishingConfigured } from "../../src/publication/runtime.js";
import { generateTestGitHubAppKeys } from "./github-test-utils.js";

const repositoryPolicy = JSON.stringify([{
  owner: "CyanAutomation",
  repository: "canary-repo",
  operations: ["branch", "pr"],
  baseBranches: ["main"],
}]);

describe("production publication configuration", () => {
  it("keeps publishing disabled unless the explicit commissioning gate is true", async () => {
    const { credentials } = await generateTestGitHubAppKeys();
    await expect(createProductionPublicationService({
      PUBLISHING_ENABLED: "false",
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
      GITHUB_REPOSITORY_ALLOWLIST: repositoryPolicy,
    })).rejects.toMatchObject({ code: "PUBLISHING_UNAVAILABLE" });
    await expect(isProductionPublishingConfigured({ PUBLISHING_ENABLED: "false" })).resolves.toBe(false);
  });

  it("fails closed for missing secrets, empty or malformed allowlists, and invalid keys", async () => {
    const { credentials } = await generateTestGitHubAppKeys();
    const base = { PUBLISHING_ENABLED: "true", GITHUB_APP_ID: credentials.appId };
    const incomplete = [
      { ...base, GITHUB_REPOSITORY_ALLOWLIST: repositoryPolicy },
      { ...base, GITHUB_APP_PRIVATE_KEY: credentials.privateKey, GITHUB_REPOSITORY_ALLOWLIST: "[]" },
      { ...base, GITHUB_APP_PRIVATE_KEY: credentials.privateKey, GITHUB_REPOSITORY_ALLOWLIST: "not-json" },
      { ...base, GITHUB_APP_PRIVATE_KEY: "not-a-private-key", GITHUB_REPOSITORY_ALLOWLIST: repositoryPolicy },
    ];

    for (const environment of incomplete) {
      await expect(createProductionPublicationService(environment)).rejects.toMatchObject({ code: "PUBLISHING_UNAVAILABLE" });
      await expect(isProductionPublishingConfigured(environment)).resolves.toBe(false);
    }
  });

  it("builds the real adapter only from valid, exact allowlist configuration", async () => {
    const { credentials } = await generateTestGitHubAppKeys();
    const service = await createProductionPublicationService({
      PUBLISHING_ENABLED: "true",
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
      GITHUB_REPOSITORY_ALLOWLIST: repositoryPolicy,
    });

    expect(service.adapter).toBeInstanceOf(RealGitHubAdapter);
    expect(await isProductionPublishingConfigured({
      PUBLISHING_ENABLED: "true",
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
      GITHUB_REPOSITORY_ALLOWLIST: repositoryPolicy,
    })).toBe(true);
  });

  it("rejects allowlist entries with wildcards or extra fields", async () => {
    const { credentials } = await generateTestGitHubAppKeys();
    const base = {
      PUBLISHING_ENABLED: "true",
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
    };
    for (const allowlist of [
      JSON.stringify([{ owner: "*", repository: "repo", operations: ["branch"], baseBranches: ["main"] }]),
      JSON.stringify([{ owner: "org", repository: "repo", operations: ["branch"], baseBranches: ["main"], installationId: 1 }]),
    ]) {
      await expect(createProductionPublicationService({ ...base, GITHUB_REPOSITORY_ALLOWLIST: allowlist }))
        .rejects.toMatchObject({ code: "PUBLISHING_UNAVAILABLE" });
    }
  });
});

it("uses only a generic unavailable failure for malformed runtime state", async () => {
  const error = await createProductionPublicationService({
    PUBLISHING_ENABLED: "true",
    GITHUB_APP_ID: "3345400",
    GITHUB_APP_PRIVATE_KEY: "private-key-value-must-not-escape",
    GITHUB_REPOSITORY_ALLOWLIST: repositoryPolicy,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublicationFailure);
  expect((error as Error).message).not.toContain("private-key-value-must-not-escape");
});
