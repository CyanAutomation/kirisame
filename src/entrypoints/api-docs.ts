import openApiSource from "../../docs/openapi.json";

type ApiResponseContent = {
  schema?: unknown;
  example?: unknown;
};

type ApiResponse = {
  $ref?: string;
  description?: string;
  headers?: Record<string, { description?: string; schema?: unknown }>;
  content?: Record<string, ApiResponseContent>;
};

type ApiOperation = {
  operationId: string;
  summary: string;
  description: string;
  tags?: string[];
  responses: Record<string, ApiResponse>;
};

type ApiDocument = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, { get?: ApiOperation }>;
  components: { schemas: Record<string, unknown>; responses: Record<string, unknown> };
};

const openApiDocument = openApiSource as ApiDocument;

export function openApiResponse(): Response {
  return new Response(JSON.stringify(openApiDocument), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

export function apiDocsResponse(): Response {
  return new Response(renderApiDocs(), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function renderApiDocs(): string {
  const operations = Object.entries(openApiDocument.paths)
    .flatMap(([path, pathItem]) => pathItem.get ? [renderOperation(path, pathItem.get)] : [])
    .join("\n");
  const notFoundResponse = renderResponse("404", { $ref: "#/components/responses/NotFound" });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Kirisame public HTTP API reference">
    <title>${escapeHtml(openApiDocument.info.title)} reference</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; color: #17212b; background: #f4f7f9; }
      * { box-sizing: border-box; }
      body { margin: 0; }
      main { width: min(980px, calc(100% - 32px)); margin: 48px auto; }
      header, .operation, .notice { border: 1px solid #d8e0e6; border-radius: 12px; background: #fff; }
      header { padding: 32px; }
      h1, h2, h3, p { margin-top: 0; }
      h1 { margin-bottom: 8px; font-size: clamp(2rem, 5vw, 3rem); letter-spacing: -0.04em; }
      h2 { margin: 0; font-size: 1.2rem; }
      h3 { margin-bottom: 8px; font-size: 1rem; }
      p { line-height: 1.55; }
      .eyebrow, .muted { color: #526271; }
      .eyebrow { margin-bottom: 8px; font-size: .8rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
      .spec-link { display: inline-block; margin-top: 4px; color: #075fa8; font-weight: 700; }
      .notice { margin: 20px 0 36px; padding: 18px 20px; border-left: 5px solid #c88716; }
      .notice p:last-child { margin-bottom: 0; }
      a { color: #075fa8; }
      .operation { margin: 16px 0; padding: 22px; }
      .operation-title { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 14px; }
      .method { padding: 5px 9px; border-radius: 6px; background: #e1f3e8; color: #176b37; font-size: .75rem; font-weight: 800; letter-spacing: .06em; }
      code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
      .route { font-size: 1rem; overflow-wrap: anywhere; }
      .operation-id { margin: 0 0 12px; color: #526271; font-size: .85rem; }
      .response { margin-top: 18px; padding-top: 16px; border-top: 1px solid #e3e9ed; }
      .response-code { display: inline-block; min-width: 42px; margin-right: 8px; font-weight: 800; }
      .media-type { margin: 10px 0 6px; color: #526271; font-size: .85rem; }
      pre { max-height: 360px; overflow: auto; margin: 8px 0 0; padding: 14px; border-radius: 8px; background: #f4f7f9; font-size: .8rem; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
      footer { padding: 20px 0; color: #526271; font-size: .85rem; }
      @media (max-width: 560px) { main { margin-top: 20px; } header, .operation { padding: 20px; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="eyebrow">OpenAPI ${escapeHtml(openApiDocument.openapi)} · API version ${escapeHtml(openApiDocument.info.version)}</p>
        <h1>${escapeHtml(openApiDocument.info.title)} reference</h1>
        <p class="muted">Public HTTP operations for service metadata, liveness, readiness, and API documentation.</p>
        <a class="spec-link" href="/openapi.json">Download the OpenAPI JSON</a>
      </header>
      <aside class="notice">
        <h2>Private publishing interface</h2>
        <p>Publishing is available only through the authenticated private Cloudflare Service Binding RPC, using <code>PublisherEntrypoint.publish(requestJson, callerId, apiKey)</code>. It is not a public HTTP endpoint. See the <a href="https://github.com/CyanAutomation/kirisame/blob/main/docs/SOYUZ-INTEGRATION.md">Soyuz integration guide</a>.</p>
      </aside>
      <section aria-label="HTTP operations">
        ${operations}
      </section>
      <section class="operation" aria-labelledby="unmatched-paths">
        <h2 id="unmatched-paths">Unmatched paths</h2>
        <p>Requests to public paths without a documented operation return this response.</p>
        ${notFoundResponse}
      </section>
      <footer>Documented routes accept GET requests only. Publication remains available through the private Service Binding RPC.</footer>
    </main>
  </body>
</html>`;
}

function renderOperation(path: string, operation: ApiOperation): string {
  const responses = Object.entries(operation.responses)
    .map(([status, response]) => renderResponse(status, response))
    .join("\n");

  return `<article class="operation" id="${escapeHtml(operation.operationId)}">
  <div class="operation-title"><span class="method">GET</span><code class="route">${escapeHtml(path)}</code><h2>${escapeHtml(operation.summary)}</h2></div>
  <p class="operation-id">${escapeHtml(operation.operationId)}${operation.tags?.length ? ` · ${escapeHtml(operation.tags.join(", "))}` : ""}</p>
  <p>${escapeHtml(operation.description)}</p>
  <h3>Responses</h3>
  ${responses}
</article>`;
}

function renderResponse(status: string, response: ApiResponse): string {
  const resolvedResponse = resolveResponse(response);
  const headers = Object.entries(resolvedResponse.headers ?? {})
    .map(([name, header]) => `<div class="response-header"><p><strong>${escapeHtml(name)} header:</strong> ${escapeHtml(header.description ?? "")}</p>${header.schema ? `<pre><code>${escapeHtml(JSON.stringify(header.schema, null, 2))}</code></pre>` : ""}</div>`)
    .join("");
  const content = Object.entries(resolvedResponse.content ?? {})
    .map(([mediaType, media]) => `<p class="media-type">${escapeHtml(mediaType)}${media.schema ? ` · schema` : ""}</p>${media.schema ? `<pre><code>${escapeHtml(JSON.stringify(resolveSchema(media.schema), null, 2))}</code></pre>` : ""}${media.example !== undefined ? `<p class="media-type">Example response</p><pre><code>${escapeHtml(JSON.stringify(media.example, null, 2))}</code></pre>` : ""}`)
    .join("");

  return `<div class="response"><p><span class="response-code">${escapeHtml(status)}</span>${escapeHtml(resolvedResponse.description ?? "Response")}</p>${headers}${content}</div>`;
}

function resolveResponse(response: ApiResponse): ApiResponse {
  if (!response.$ref) return response;
  const componentName = response.$ref.split("/").at(-1);
  const definition = componentName ? openApiDocument.components.responses[componentName] : undefined;
  return isRecord(definition) ? definition as ApiResponse : response;
}

function resolveSchema(schema: unknown, seenReferences = new Set<string>()): unknown {
  if (Array.isArray(schema)) return schema.map((item) => resolveSchema(item, seenReferences));
  if (!isRecord(schema)) return schema;

  if (typeof schema.$ref === "string") {
    const reference = schema.$ref;
    if (seenReferences.has(reference)) return { $ref: reference };
    const componentName = reference.split("/").at(-1);
    const definition = componentName ? openApiDocument.components.schemas[componentName] : undefined;
    if (definition) {
      const nestedReferences = new Set(seenReferences);
      nestedReferences.add(reference);
      return { $ref: reference, definition: resolveSchema(definition, nestedReferences) };
    }
  }

  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, resolveSchema(value, new Set(seenReferences))]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}
