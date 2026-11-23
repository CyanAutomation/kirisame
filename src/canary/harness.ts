import { validateContract } from "../contracts/validate.js";
import type { PublicationRequest, PublisherResponse } from "../contracts/types.js";
import { MAX_REQUEST_BODY_BYTES } from "../entrypoints/publisher.js";
import { readLimitedBytes } from "../shared/streams.js";

interface CanaryPublisherBinding {
  publish(requestJson: string): Promise<PublisherResponse>;
}

interface CanaryEnvironment extends Record<string, unknown> {
  KIRISAME?: CanaryPublisherBinding;
  KIRISAME_CANARY_ENABLED?: unknown;
  KIRISAME_CANARY_REPOSITORY?: unknown;
  KIRISAME_CANARY_BASE_REF?: unknown;
}

interface ConfiguredCanaryEnvironment extends CanaryEnvironment {
  KIRISAME: CanaryPublisherBinding;
  KIRISAME_CANARY_REPOSITORY: string;
  KIRISAME_CANARY_BASE_REF: string;
}

const NOT_FOUND = { code: "NOT_FOUND", message: "Not found" };

export default {
  fetch(request: Request, environment: unknown = {}): Promise<Response> {
    return handleCanaryRequest(request, environment);
  },
};

export async function handleCanaryRequest(request: Request, environment: unknown): Promise<Response> {
  if (!isCanaryPublishRequest(request)) return json(NOT_FOUND, 404);
  const canaryEnvironment = readCanaryEnvironment(environment);
  if (!canaryEnvironment) return json({ code: "CANARY_UNAVAILABLE", message: "The private canary is not configured." }, 503);

  const parsed = await parseCanaryRequest(request);
  if (parsed instanceof Response) return parsed;
  if (!isWithinCanaryScope(parsed.publication, canaryEnvironment)) {
    return json({ code: "CANARY_POLICY_DENIED", message: "The request is outside the explicitly configured canary scope." }, 403);
  }
  return publishAndReplay(parsed.requestJson, canaryEnvironment.KIRISAME);
}

function isCanaryPublishRequest(request: Request): boolean {
  const url = new URL(request.url);
  return isLoopbackHost(url.hostname) && url.pathname === "/__canary/publish-replay" && request.method === "POST";
}

function readCanaryEnvironment(environment: unknown): ConfiguredCanaryEnvironment | undefined {
  if (!isRecord(environment)) return undefined;
  const canary = environment as CanaryEnvironment;
  return canary.KIRISAME_CANARY_ENABLED === "true"
    && typeof canary.KIRISAME_CANARY_REPOSITORY === "string" && Boolean(canary.KIRISAME_CANARY_REPOSITORY)
    && typeof canary.KIRISAME_CANARY_BASE_REF === "string" && Boolean(canary.KIRISAME_CANARY_BASE_REF)
    && isPublisherBinding(canary.KIRISAME) ? canary as ConfiguredCanaryEnvironment : undefined;
}

async function parseCanaryRequest(request: Request): Promise<{ requestJson: string; publication: PublicationRequest } | Response> {
  const requestJson = await readRequestJson(request);
  if (requestJson === undefined) {
    return json({ code: "INVALID_REQUEST", message: "The request is invalid or exceeds the configured size limit." }, 400);
  }

  let body: unknown;
  try {
    body = JSON.parse(requestJson);
  } catch {
    return json({ code: "INVALID_REQUEST", message: "The request must be valid JSON." }, 400);
  }
  const validation = await validateContract("publication-request", body);
  if (!validation.valid) {
    return json({ code: "INVALID_REQUEST", message: "The request does not match the Kirisame v1 contract." }, 400);
  }
  return { requestJson, publication: body as PublicationRequest };
}

function isWithinCanaryScope(publication: PublicationRequest, environment: ConfiguredCanaryEnvironment): boolean {
  const allowedRepository = environment.KIRISAME_CANARY_REPOSITORY;
  const [owner, name, extra] = allowedRepository.split("/");
  return extra === undefined && Boolean(owner && name)
    && publication.mode === "pr"
    && `${publication.repository.owner}/${publication.repository.name}`.toLowerCase() === allowedRepository.toLowerCase()
    && publication.baseRef === environment.KIRISAME_CANARY_BASE_REF
    && publication.headRef === `kirisame/p/${publication.publicationId}`;
}

async function publishAndReplay(requestJson: string, publisher: CanaryPublisherBinding): Promise<Response> {
  try {
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
  const bytes = await readLimitedBytes(request.body, MAX_REQUEST_BODY_BYTES);
  if (!bytes) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
