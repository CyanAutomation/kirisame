import { describe, expect, it } from "vitest";
import worker from "../../src/entrypoints/public.js";

describe("public diagnostics", () => {
  it("reports sanitized build provenance without exposing bindings", async () => {
    const response = await worker.fetch(new Request("https://kirisame.workers.dev/"), {
      PUBLISHING_ENABLED: "false",
      GITHUB_APP_PRIVATE_KEY: "never-return-this-private-key",
      GITHUB_REPOSITORY_ALLOWLIST: "sensitive-configuration",
      KIRISAME_SOURCE_SHA: "A".repeat(40),
      KIRISAME_APP_VERSION: "0.1.0",
      KIRISAME_CONTRACT_VERSION: "1",
      KIRISAME_BUILD_TIMESTAMP: "2026-11-22T20:45:00Z",
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      service: "kirisame",
      publishing: "unavailable",
      version: {
        sourceCommit: "a".repeat(40),
        application: "0.1.0",
        contract: "1",
        builtAt: "2026-11-22T20:45:00.000Z",
      },
    });
    expect(JSON.stringify(body)).not.toContain("never-return-this-private-key");
    expect(JSON.stringify(body)).not.toContain("sensitive-configuration");
  });

  it("keeps liveness available when build metadata is missing or malformed", async () => {
    const root = await worker.fetch(new Request("https://kirisame.workers.dev/"));
    const health = await worker.fetch(new Request("https://kirisame.workers.dev/health"));

    expect(root.status).toBe(200);
    expect(await root.json()).toMatchObject({
      publishing: "unavailable",
      version: { sourceCommit: "unknown", application: "unknown", contract: "unknown", builtAt: "unknown" },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  it("reports readiness separately from liveness and rejects unknown routes or methods", async () => {
    const ready = await worker.fetch(new Request("https://kirisame.workers.dev/readyz"));
    const wrongMethod = await worker.fetch(new Request("https://kirisame.workers.dev/health", { method: "POST" }));
    const unknown = await worker.fetch(new Request("https://kirisame.workers.dev/missing"));
    const privateRoute = await worker.fetch(new Request("https://kirisame.workers.dev/internal/v1/publications"));

    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "not_ready", publishing: "unavailable" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(unknown.status).toBe(404);
    expect(privateRoute.status).toBe(404);
  });
});
