import { validateContract } from "../contracts/validate.js";
import type { PublicationRequest, PublisherResponse } from "../contracts/types.js";
import { MAX_REQUEST_BODY_BYTES } from "../entrypoints/publisher.js";

interface CanaryPublisherBinding {
  publish(requestJson: string): Promise<PublisherResponse>;
}

interface CanaryEnvironment extends Record<string, unknown> {
  KIRISAME?: CanaryPublisherBinding;
  KIRISAME_CANARY_ENABLED?: unknown;
  KIRISAME_CANARY_REPOSITORY?: unknown;
  KIRISAME_CANARY_BASE_REF?: unknown;
}

const NOT_FOUND = { code: "NOT_FOUND", message: "Not found" };

export default {
  fetch(request: Request, environment: unknown = {}): Promise<Response> {
    return handleCanaryRequest(request, environment);
  },
};

export async function handleCanaryRequest(request: Request, environment: unknown): Promise<Response> {
  const url = new URL(request.url);
  if (!isLoopbackHost(url.hostname) || url.pathname !== "/__canary/publish-replay" || request.method !== "POST") {
    return json(NOT_FOUND, 404);
  }

  const canaryEnvironment = isRecord(environment) ? environment as CanaryEnvironment : undefined;
  if (!canaryEnvironment || canaryEnvironment.KIRISAME_CANARY_ENABLED !== "true"
    || typeof canaryEnvironment.KIRISAME_CANARY_REPOSITORY !== "string" || !canaryEnvironment.KIRISAME_CANARY_REPOSITORY
    || typeof canaryEnvironment.KIRISAME_CANARY_BASE_REF !== "string" || !canaryEnvironment.KIRISAME_CANARY_BASE_REF
    || !isPublisherBinding(canaryEnvironment.KIRISAME)) {
    return json({ code: "CANARY_UNAVAILABLE", message: "The private canary is not configured." }, 503);
  }

  const requestJson = await readRequestJson(request);
  if (requestJson === undefined) return json({ code: "INVALID_REQUEST", message: "The request is invalid or exceeds the configured size limit." }, 400);
  let body: unknown;
  try {
    body = JSON.parse(requestJson);
  } catch {
    return json({ code: "INVALID_REQUEST", message: "The request must be valid JSON." }, 400);
  }

  const validation = await validateContract("publication-request", body);
  if (!validation.valid) return json({ code: "INVALID_REQUEST", message: "The request does not match the Kirisame v1 contract." }, 400);
  const publication = body as PublicationRequest;
  const allowedRepository = canaryEnvironment.KIRISAME_CANARY_REPOSITORY;
  const [owner, name, extra] = allowedRepository.split("/");
  if (extra !== undefined || !owner || !name || publication.mode !== "pr"
    || `${publication.repository.owner}/${publication.repository.name}`.toLowerCase() !== allowedRepository.toLowerCase()
    || publication.baseRef !== canaryEnvironment.KIRISAME_CANARY_BASE_REF
    || publication.headRef !== `kirisame/p/${publication.publicationId}`) {
    return json({ code: "CANARY_POLICY_DENIED", message: "The request is outside the explicitly configured canary scope." }, 403);
  }

  try {
    const publisher = canaryEnvironment.KIRISAME;
    const first = await publisher.publish(requestJson);
    if (!isConfirmedPr(first)) return json({ first, replay: null }, 200);
    let replay: PublisherResponse | null = null;
    try {
      replay = await publisher.publish(requestJson);
    } catch {
      // Preserve the confirmed first result if only the replay call fails.
    }
    return json({ first, replay }, 200);
  } catch {
    return json({ code: "CANARY_UNCERTAIN", message: "The private publisher call did not return a confirmed result. Reuse the identical request for reconciliation." }, 503);
  }
}

async function readRequestJson(request: Request): Promise<string | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return value;
  } catch {
    return undefined;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function isPublisherBinding(value: unknown): value is CanaryPublisherBinding {
  return typeof value === "object" && value !== null && "publish" in value && typeof value.publish === "function";
}

function isConfirmedPr(response: PublisherResponse): boolean {
  return "outcome" in response && response.outcome === "pr_published";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
