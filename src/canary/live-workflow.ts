import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { PublicationRequest, PublicationResult, PublisherResponse } from "../contracts/types.js";
import { validateContract } from "../contracts/validate.js";
import { canonicalBase64ToBytes, utf8 } from "../contracts/integrity.js";
import { MAX_REQUEST_BODY_BYTES } from "../entrypoints/publisher.js";
import { CANARY_PUBLICATION_TARGET } from "../shared/canary-target.js";

const TEST_FILE_PATH = "kirisame-canary/verification.txt";
const TEST_FILE_CONTENT = "Kirisame live integration test.\n";
const TEST_PR_TITLE = "test: verify Kirisame GitHub App publication";
const TEST_PR_BODY = "Controlled integration test of Kirisame's GitHub App authentication, branch creation, PR publication and idempotent replay.";

interface PublisherBinding {
  publish(requestJson: string): Promise<PublisherResponse>;
}

interface WorkflowEnvironment {
  KIRISAME: PublisherBinding;
}

interface WorkflowParameters {
  requestJson: unknown;
}

interface DurableStep {
  do(name: string, config: { retries: { limit: 0; delay: 0 } }, callback: () => Promise<PublisherResponse>): Promise<PublisherResponse>;
}

const NO_AUTOMATIC_RETRIES = { retries: { limit: 0, delay: 0 } } as const;

export type LiveCanaryOutcome =
  | { status: "rejected"; code: "CANARY_INVALID_REQUEST" | "CANARY_POLICY_DENIED" }
  | { status: "uncertain"; code: "CANARY_UNCERTAIN" }
  | { status: "completed"; first: PublisherResponse; replay: PublisherResponse | null };

export class LiveCanaryWorkflow extends WorkflowEntrypoint<WorkflowEnvironment, WorkflowParameters> {
  async run(event: WorkflowEvent<WorkflowParameters>, step: WorkflowStep): Promise<LiveCanaryOutcome> {
    const durableStep: DurableStep = {
      do: (name, config, callback) => step.do(name, config, callback) as Promise<PublisherResponse>,
    };
    return runLiveCanary(event.payload?.requestJson, this.env.KIRISAME, durableStep);
  }
}

export async function runLiveCanary(
  requestJson: unknown,
  publisher: PublisherBinding,
  step: DurableStep,
): Promise<LiveCanaryOutcome> {
  if (typeof requestJson !== "string") return { status: "rejected", code: "CANARY_INVALID_REQUEST" };
  const request = await validateLiveCanaryRequest(requestJson);
  if (request === "invalid") return { status: "rejected", code: "CANARY_INVALID_REQUEST" };
  if (request === "out-of-scope") return { status: "rejected", code: "CANARY_POLICY_DENIED" };

  let first: PublisherResponse;
  try {
    first = await step.do("initial-publication", NO_AUTOMATIC_RETRIES, () => publisher.publish(requestJson));
  } catch {
    return { status: "uncertain", code: "CANARY_UNCERTAIN" };
  }
  if (!isConfirmedPublication(first, request)) return { status: "completed", first, replay: null };

  let replay: PublisherResponse | null;
  try {
    replay = await step.do("identical-request-replay", NO_AUTOMATIC_RETRIES, () => publisher.publish(requestJson));
  } catch {
    replay = null;
  }
  return { status: "completed", first, replay };
}

async function validateLiveCanaryRequest(value: unknown): Promise<PublicationRequest | "invalid" | "out-of-scope"> {
  if (typeof value !== "string" || utf8(value).byteLength > MAX_REQUEST_BODY_BYTES) return "invalid";

  let request: unknown;
  try {
    request = JSON.parse(value);
  } catch {
    return "invalid";
  }

  const validation = await validateContract("publication-request", request);
  if (!validation.valid) return "invalid";
  const publication = request as PublicationRequest;
  return isWithinLiveCanaryScope(publication) ? publication : "out-of-scope";
}

function isWithinLiveCanaryScope(request: PublicationRequest): boolean {
  if (request.repository.owner.toLowerCase() !== CANARY_PUBLICATION_TARGET.owner.toLowerCase()
    || request.repository.name.toLowerCase() !== CANARY_PUBLICATION_TARGET.repository.toLowerCase()
    || request.mode !== "pr"
    || request.baseRef !== CANARY_PUBLICATION_TARGET.baseRef
    || request.headRef !== "kirisame/p/" + request.publicationId
    || request.title !== TEST_PR_TITLE
    || request.body !== TEST_PR_BODY
    || request.artifact.files.length !== 1) return false;

  const [file] = request.artifact.files;
  if (!file || file.operation !== "add" || file.path !== TEST_FILE_PATH) return false;
  const bytes = canonicalBase64ToBytes(file.content.data);
  if (!bytes || bytes.byteLength !== file.content.byteLength) return false;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes) === TEST_FILE_CONTENT;
  } catch {
    return false;
  }
}

function isConfirmedPublication(
  response: PublisherResponse,
  request: PublicationRequest,
): response is PublicationResult {
  if (!("outcome" in response) || response.outcome !== "pr_published") return false;
  return response.publicationId === request.publicationId
    && response.runId === request.runId
    && response.mode === "pr"
    && response.repository.owner.toLowerCase() === request.repository.owner.toLowerCase()
    && response.repository.name.toLowerCase() === request.repository.name.toLowerCase()
    && response.branch?.ref === request.headRef
    && /^[a-f0-9]{40}$/u.test(response.branch.commitSha)
    && response.pullRequest?.state === "open"
    && response.pullRequest.url.toLowerCase() === `https://github.com/${request.repository.owner}/${request.repository.name}/pull/${response.pullRequest.number}`.toLowerCase();
}

export default {
  fetch(_request: Request): Response {
    return new Response(JSON.stringify({ code: "NOT_FOUND", message: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};
