import { describe, expect, it } from "vitest";
import { PublicationFailure } from "../../src/errors/publication-error.js";
import {
  createProductionPublicationService,
  isProductionPublishingConfigured,
  verifyCanaryRepositoryAuthorization,
} from "../../src/publication/runtime.js";
import { generateTestGitHubAppKeys } from "./github-test-utils.js";

const callerKeys = JSON.stringify({ soyuz: ["A".repeat(43)] });

describe("production publication configuration", () => {
  it("verifies only the fixed Somatic PR installation scope while publishing is disabled", async () => {
    const { credentials } = await generateTestGitHubAppKeys();
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ path: url.pathname, method, ...(body ? { body } : {}) });
      if (url.pathname === "/repos/CyanAutomation/somatic/installation") {
        return json({
          id: 42,
          app_id: 3345400,
          account: { login: "CyanAutomation" },
          permissions: { metadata: "read", contents: "write", pull_requests: "write" },
          suspended_at: null,
        });
      }
      if (url.pathname === "/app/installations/42/access_tokens") {
        return json({
          token: "opaque-installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { metadata: "read", contents: "write", pull_requests: "write" },
          repositories: [{ id: 77, full_name: "CyanAutomation/somatic" }],
        }, 201);
      }
      if (url.pathname === "/repos/CyanAutomation/somatic") {
        return json({ id: 77, full_name: "CyanAutomation/somatic" });
      }
      throw new Error("unexpected GitHub request");
    };

    await expect(verifyCanaryRepositoryAuthorization({
      PUBLISHING_ENABLED: "false",
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
    }, fetcher)).resolves.toEqual({
      status: "verified",
      repository: "CyanAutomation/somatic",
    });

    expect(calls.map(({ path, method }) => [path, method])).toEqual([
      ["/repos/CyanAutomation/somatic/installation", "GET"],
      ["/app/installations/42/access_tokens", "POST"],
      ["/repos/CyanAutomation/somatic", "GET"],
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      repositories: ["somatic"],
      permissions: { contents: "write", pull_requests: "write" },
    });
  });

  it("reports configuration, key-format, and installation failures by stage", async () => {
    const { credentials } = await generateTestGitHubAppKeys();
    await expect(verifyCanaryRepositoryAuthorization({
      GITHUB_APP_ID: "wrong-app-id",
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
    })).resolves.toEqual({
      status: "rejected",
      code: "PUBLISHING_UNAVAILABLE",
      failureStage: "configuration",
    });

    await expect(verifyCanaryRepositoryAuthorization({
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: "malformed-key-material",
    })).resolves.toEqual({
      status: "rejected",
      code: "PUBLISHING_UNAVAILABLE",
      failureStage: "private_key_pem_envelope",
    });

    const responseDetail = "github-error-body-must-not-escape";
    const rejectedByGitHub: typeof fetch = async () => json({ message: responseDetail }, 401);
    const githubFailure = await verifyCanaryRepositoryAuthorization({
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
    }, rejectedByGitHub);
    expect(githubFailure).toEqual({
      status: "rejected",
      code: "GITHUB_AUTH_INVALID",
      failureStage: "installation_and_token_scope",
      diagnostic: { step: "installation_lookup", httpStatus: 401 },
    });
    expect(JSON.stringify(githubFailure)).not.toContain(responseDetail);
  });

  it("identifies token-response validation without returning GitHub response content", async () => {
    const { credentials } = await generateTestGitHubAppKeys();
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/installation")) return json({
        id: 42, app_id: 3345400, account: { login: "CyanAutomation" },
        permissions: { metadata: "read", contents: "write", pull_requests: "write" }, suspended_at: null,
      });
      return json({ message: "sensitive-response-body" }, 201);
    };
    const result = await verifyCanaryRepositoryAuthorization({
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
    }, fetcher);

    expect(result).toEqual({
      status: "rejected",
      code: "GITHUB_UNAVAILABLE",
      failureStage: "installation_and_token_scope",
      diagnostic: { step: "token_validation", httpStatus: 201 },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-response-body");
    expect(JSON.stringify(result)).not.toContain(credentials.privateKey);
  });

  it("keeps publishing disabled unless the explicit commissioning gate is true", async () => {
    const { credentials } = await generateTestGitHubAppKeys();
    await expect(createProductionPublicationService({
      PUBLISHING_ENABLED: "false",
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
    })).rejects.toMatchObject({ code: "PUBLISHING_UNAVAILABLE" });
    await expect(isProductionPublishingConfigured({ PUBLISHING_ENABLED: "false" })).resolves.toBe(false);
  });

  it("fails closed for missing or invalid GitHub App settings", async () => {
    const { credentials } = await generateTestGitHubAppKeys();
    const base = { PUBLISHING_ENABLED: "true", GITHUB_APP_ID: credentials.appId };
    const incomplete = [
      base,
      { ...base, GITHUB_APP_PRIVATE_KEY: "not-a-private-key" },
    ];

    for (const environment of incomplete) {
      await expect(createProductionPublicationService(environment)).rejects.toMatchObject({ code: "PUBLISHING_UNAVAILABLE" });
      await expect(isProductionPublishingConfigured(environment)).resolves.toBe(false);
    }
  });

  it("builds a production service without any receiver-side repository allowlist", async () => {
    const { credentials } = await generateTestGitHubAppKeys();
    const service = await createProductionPublicationService({
      PUBLISHING_ENABLED: "true",
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
    });

    expect("adapter" in service).toBe(false);
    expect("policy" in service).toBe(false);
    expect(await isProductionPublishingConfigured({
      PUBLISHING_ENABLED: "true",
      GITHUB_APP_ID: credentials.appId,
      GITHUB_APP_PRIVATE_KEY: credentials.privateKey,
      KIRISAME_CALLER_KEYS: callerKeys,
    })).toBe(true);
  });

});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

it("uses only a generic unavailable failure for malformed runtime state", async () => {
  const error = await createProductionPublicationService({
    PUBLISHING_ENABLED: "true",
    GITHUB_APP_ID: "3345400",
    GITHUB_APP_PRIVATE_KEY: "private-key-value-must-not-escape",
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublicationFailure);
  expect((error as Error).message).not.toContain("private-key-value-must-not-escape");
});
