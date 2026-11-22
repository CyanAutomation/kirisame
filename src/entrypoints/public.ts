import { isProductionPublishingConfigured } from "../publication/runtime.js";

const SERVICE = "kirisame";

export default {
  async fetch(request: Request, env: unknown = {}): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/v1/publications") return json({ code: "NOT_FOUND", message: "Not found" }, 404);

    const routes = new Map<string, string>([["/", "GET"], ["/health", "GET"], ["/readyz", "GET"]]);
    const method = routes.get(url.pathname);
    if (!method) return json({ code: "NOT_FOUND", message: "Not found" }, 404);
    if (request.method !== method) return json({ code: "METHOD_NOT_ALLOWED", message: "Method not allowed" }, 405, { allow: method });

    if (url.pathname === "/") {
      const available = await isProductionPublishingConfigured(env);
      return json({
        service: SERVICE,
        implementation: "github-app-publisher",
        publishing: available ? "available" : "unavailable",
        version: deploymentVersion(env),
      }, 200);
    }
    if (url.pathname === "/health") return json({ status: "ok" }, 200);
    const available = await isProductionPublishingConfigured(env);
    return json({ status: available ? "ready" : "not_ready", publishing: available ? "available" : "unavailable" }, available ? 200 : 503);
  },
};

function deploymentVersion(environment: unknown): {
  sourceCommit: string;
  application: string;
  contract: string;
  builtAt: string;
} {
  const record = isRecord(environment) ? environment : {};
  return {
    sourceCommit: typeof record.KIRISAME_SOURCE_SHA === "string" && /^[a-f0-9]{40}$/iu.test(record.KIRISAME_SOURCE_SHA)
      ? record.KIRISAME_SOURCE_SHA.toLowerCase()
      : "unknown",
    application: typeof record.KIRISAME_APP_VERSION === "string" && /^[0-9A-Za-z.+-]{1,64}$/u.test(record.KIRISAME_APP_VERSION)
      ? record.KIRISAME_APP_VERSION
      : "unknown",
    contract: record.KIRISAME_CONTRACT_VERSION === "1" ? "1" : "unknown",
    builtAt: typeof record.KIRISAME_BUILD_TIMESTAMP === "string" && Number.isFinite(Date.parse(record.KIRISAME_BUILD_TIMESTAMP))
      ? new Date(record.KIRISAME_BUILD_TIMESTAMP).toISOString()
      : "unknown",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
