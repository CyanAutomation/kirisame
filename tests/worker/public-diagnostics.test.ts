import { describe, expect, it } from "vitest";
import worker, { PUBLIC_ROUTE_PATHS } from "../../src/entrypoints/public.js";

function openApiReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(openApiReferences);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => key === "$ref" && typeof nested === "string"
    ? [nested]
    : openApiReferences(nested));
}

function hasMethodNotAllowedResponse(pathItem: { get?: { responses?: Record<string, unknown> } }): boolean {
  return Object.keys(pathItem).length === 1
    && pathItem.get !== undefined
    && pathItem.get.responses?.["405"] !== undefined;
}

function isKnownComponentReference(
  reference: string,
  components: { schemas?: Record<string, unknown>; responses?: Record<string, unknown> } | undefined,
): boolean {
  const match = /^#\/components\/(schemas|responses)\/([^/]+)$/u.exec(reference);
  if (!match) return false;
  return components?.[match[1] as "schemas" | "responses"]?.[match[2]] !== undefined;
}

describe("public diagnostics", () => {
  it("reports sanitized build provenance without exposing bindings", async () => {
    const response = await worker.fetch(new Request("https://kirisame.workers.dev/"), {
      PUBLISHING_ENABLED: "false",
      GITHUB_APP_PRIVATE_KEY: "never-return-this-private-key",
      KIRISAME_CALLER_KEYS: "sensitive-configuration",
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

  it.each(["/docs", "/docs/"])("serves the hand-built API reference at %s", async (path) => {
    const response = await worker.fetch(new Request(`https://kirisame.workers.dev${path}`));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html; charset=utf-8$/u);
    expect(html).toContain("Kirisame API reference");
    expect(html).toContain('href="/openapi.json"');
    expect(html).toContain("private Cloudflare Service Binding");
    expect(html).toContain("Unmatched paths");
    expect(html).toContain("Example response");
    expect(html).toContain("&quot;status&quot;: &quot;ok&quot;");
    expect(html).not.toContain("<script");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves an OpenAPI 3.1 document for public HTTP operations only", async () => {
    const response = await worker.fetch(new Request("https://kirisame.workers.dev/openapi.json"));
    const document = await response.json() as {
      openapi?: string;
      info?: { title?: string; version?: string };
      paths?: Record<string, { get?: { operationId?: string; responses?: Record<string, unknown> } }>;
      components?: { schemas?: Record<string, unknown>; responses?: Record<string, unknown> };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json; charset=utf-8$/u);
    expect(document.openapi).toMatch(/^3\.1\./u);
    expect(document.info).toMatchObject({ title: "Kirisame API", version: "1" });
    expect(document.paths).toHaveProperty("/");
    expect(document.paths).toHaveProperty("/health");
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([...PUBLIC_ROUTE_PATHS].sort());
    const pathItems = Object.values(document.paths ?? {});
    expect(pathItems.every(hasMethodNotAllowedResponse)).toBe(true);
    const operationIds = pathItems.map((pathItem) => pathItem.get?.operationId);
    expect(operationIds.every((operationId) => typeof operationId === "string" && operationId.length > 0)).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(openApiReferences(document).every((reference) => isKnownComponentReference(reference, document.components))).toBe(true);
    expect(document.paths?.["/readyz"]?.get?.responses).toHaveProperty("200");
    expect(document.paths?.["/readyz"]?.get?.responses).toHaveProperty("503");
    expect(document.paths).not.toHaveProperty("/internal/v1/publications");
  });

  it.each(["/docs", "/docs/", "/openapi.json"])("allows only GET for documentation route %s", async (path) => {
    const response = await worker.fetch(new Request(`https://kirisame.workers.dev${path}`, { method: "POST" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(await response.json()).toEqual({ code: "METHOD_NOT_ALLOWED", message: "Method not allowed" });
  });
});
