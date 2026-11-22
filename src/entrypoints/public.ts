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
      return json({ service: SERVICE, implementation: "worker-foundation", publishing: available ? "available" : "unavailable" }, 200);
    }
    if (url.pathname === "/health") return json({ status: "ok" }, 200);
    const available = await isProductionPublishingConfigured(env);
    return json({ status: available ? "ready" : "not_ready", publishing: available ? "available" : "unavailable" }, available ? 200 : 503);
  },
};

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
