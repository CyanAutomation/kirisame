import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { CanaryAuthorizationResult, PublicationRequest, PublicationResult, PublisherResponse } from "../contracts/types.js";
import { validateContract } from "../contracts/validate.js";
import { canonicalBase64ToBytes, utf8 } from "../contracts/integrity.js";
import { MAX_REQUEST_BODY_BYTES } from "../entrypoints/publisher.js";
import { CANARY_PUBLICATION_TARGET } from "../shared/canary-target.js";

const TEST_FILE_PATH = "kirisame-canary/verification.txt";
const TEST_FILE_CONTENT = "Kirisame live integration test.\n";
const TEST_PR_TITLE = "test: verify Kirisame GitHub App publication";
const TEST_PR_BODY = "Controlled integration test of Kirisame's GitHub App authentication, branch creation, PR publication and idempotent replay.";
const APP_SCOPE_PROBE_TARGET = {
  owner: "cyanautomation",
  repository: "kirisame-app-scope-probe-never-create",
  baseRef: "main",
} as const;

interface PublisherBinding {
  publish(requestJson: string, callerId: string, apiKey: string): Promise<PublisherResponse>;
  verifyCanaryAuthorization(callerId: string, apiKey: string): Promise<CanaryAuthorizationResult>;
}

interface AuthorizedPublisher {
  publish(requestJson: string): Promise<PublisherResponse>;
  verifyCanaryAuthorization(): Promise<CanaryAuthorizationResult>;
}

interface WorkflowEnvironment {
  KIRISAME: PublisherBinding;
  KIRISAME_CALLER_ID: string;
  KIRISAME_API_KEY: string;
}

interface WorkflowParameters {
  action?: "preflight" | "app-scope-probe" | "publish";
  requestJson: unknown;
}

interface DurableStep {
  do(name: string, config: object, callback: () => Promise<{ status: "ready" }>): Promise<{ status: "ready" }>;
  do(name: string, config: object, callback: () => Promise<CanaryAuthorizationStepResult>): Promise<CanaryAuthorizationStepResult>;
  do(name: string, callback: () => Promise<{ status: "ready" }>): Promise<{ status: "ready" }>;
  do(
    name: string,
    callback: () => Promise<CanaryAuthorizationStepResult>,
  ): Promise<CanaryAuthorizationStepResult>;
  do(
    name: string,
    config: { retries: { limit: 0; delay: "1 second" } },
    callback: () => Promise<PublisherResponse>,
  ): Promise<PublisherResponse>;
  do(
    name: string,
    config: { retries: { limit: 0; delay: "1 second" } },
    callback: () => Promise<CanaryAuthorizationResult>,
  ): Promise<CanaryAuthorizationResult>;
}

type CanaryAuthorizationStepResult =
  | { kind: "verified"; result: CanaryAuthorizationResult }
  | { kind: "publisher-failure"; failureName: SafeWorkflowFailureName };

const NO_AUTOMATIC_RETRIES = { retries: { limit: 0, delay: "1 second" } } as const;

export type LiveCanaryOutcome =
  | { status: "rejected"; code: "CANARY_INVALID_REQUEST" | "CANARY_POLICY_DENIED" }
  | { status: "uncertain"; code: "CANARY_UNCERTAIN" }
  | { status: "completed"; first: PublisherResponse; replay: PublisherResponse | null };

export type LiveCanaryPreflightOutcome = CanaryAuthorizationResult
  | {
    status: "uncertain";
    code: "CANARY_PREFLIGHT_UNCERTAIN";
    failureName: SafeWorkflowFailureName;
    failureStage: SafePreflightFailureStage;
  };

export type LiveCanaryAppScopeProbeOutcome =
  | { status: "rejected"; code: "CANARY_INVALID_REQUEST" | "CANARY_APP_SCOPE_PROBE_DENIED" }
  | { status: "uncertain"; code: "CANARY_APP_SCOPE_PROBE_UNCERTAIN" }
  | { status: "confirmed-app-denial"; response: PublisherResponse }
  | { status: "unexpected"; response: PublisherResponse };

export class LiveCanaryWorkflow extends WorkflowEntrypoint<WorkflowEnvironment, WorkflowParameters> {
  async run(
    event: WorkflowEvent<WorkflowParameters>,
    step: WorkflowStep,
  ): Promise<LiveCanaryOutcome | LiveCanaryPreflightOutcome | LiveCanaryAppScopeProbeOutcome> {
    const parameters = parseWorkflowParameters(event.payload);
    const durableStep = step as unknown as DurableStep;
    const publisher = withCallerCredentials(this.env.KIRISAME, this.env.KIRISAME_CALLER_ID, this.env.KIRISAME_API_KEY);
    if (parameters?.action === "preflight") return runLiveCanaryPreflight(publisher, durableStep);
    if (parameters?.action === "app-scope-probe") {
      return runLiveCanaryAppScopeProbe(parameters.requestJson, publisher, durableStep);
    }
    if (parameters?.action !== undefined && parameters.action !== "publish") {
      return { status: "rejected", code: "CANARY_INVALID_REQUEST" };
    }
    return runLiveCanary(parameters?.requestJson, publisher, durableStep);
  }
}

function parseWorkflowParameters(value: unknown): WorkflowParameters | undefined {
  let payload = value;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as WorkflowParameters
    : undefined;
}

export async function runLiveCanaryPreflight(
  publisher: Pick<AuthorizedPublisher, "verifyCanaryAuthorization">,
  step: DurableStep,
): Promise<LiveCanaryPreflightOutcome> {
  try {
    await step.do("workflow-step-runtime-probe", {}, async () => ({ status: "ready" }));
    const result = await step.do("github-app-installation-and-token-preflight", {}, async () => {
      try {
        return { kind: "verified", result: await publisher.verifyCanaryAuthorization() } as const;
      } catch (error) {
        return { kind: "publisher-failure", failureName: safeWorkflowFailureName(error) } as const;
      }
    });
    return result.kind === "verified"
      ? result.result
      : {
        status: "uncertain",
        code: "CANARY_PREFLIGHT_UNCERTAIN",
        failureName: result.failureName,
        failureStage: "publisher-binding",
      };
  } catch (error) {
    return {
      status: "uncertain",
      code: "CANARY_PREFLIGHT_UNCERTAIN",
      failureName: safeWorkflowFailureName(error),
      failureStage: "workflow-step",
    };
  }
}

type SafeWorkflowFailureName = "Error" | "TypeError" | "RangeError" | "ReferenceError" | "SyntaxError" | "AggregateError" | "RpcError" | "WorkflowError" | "UnknownError";
type SafePreflightFailureStage = "workflow-step" | "publisher-binding";
const SAFE_WORKFLOW_FAILURE_NAMES: ReadonlySet<string> = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AggregateError", "RpcError", "WorkflowError",
]);

function safeWorkflowFailureName(error: unknown): SafeWorkflowFailureName {
  if (!(error instanceof Error) || !SAFE_WORKFLOW_FAILURE_NAMES.has(error.name)) return "UnknownError";
  return error.name as SafeWorkflowFailureName;
}

export async function runLiveCanaryAppScopeProbe(
  requestJson: unknown,
  publisher: Pick<AuthorizedPublisher, "publish">,
  step: DurableStep,
): Promise<LiveCanaryAppScopeProbeOutcome> {
  if (typeof requestJson !== "string") return { status: "rejected", code: "CANARY_INVALID_REQUEST" };
  const request = await validateLiveCanaryRequest(requestJson, APP_SCOPE_PROBE_TARGET);
  if (request === "invalid") return { status: "rejected", code: "CANARY_INVALID_REQUEST" };
  if (request === "out-of-scope") return { status: "rejected", code: "CANARY_APP_SCOPE_PROBE_DENIED" };

  let response: PublisherResponse;
  try {
    response = await step.do("github-app-installation-scope-probe", NO_AUTOMATIC_RETRIES, () =>
      publisher.publish(requestJson));
  } catch {
    return { status: "uncertain", code: "CANARY_APP_SCOPE_PROBE_UNCERTAIN" };
  }
  return isAppScopeDenied(response)
    ? { status: "confirmed-app-denial", response }
    : { status: "unexpected", response };
}

export async function runLiveCanary(
  requestJson: unknown,
  publisher: Pick<AuthorizedPublisher, "publish">,
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

async function validateLiveCanaryRequest(
  value: unknown,
  target: typeof CANARY_PUBLICATION_TARGET | typeof APP_SCOPE_PROBE_TARGET = CANARY_PUBLICATION_TARGET,
): Promise<PublicationRequest | "invalid" | "out-of-scope"> {
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
  return isWithinLiveCanaryScope(publication, target) ? publication : "out-of-scope";
}

function isWithinLiveCanaryScope(
  request: PublicationRequest,
  target: typeof CANARY_PUBLICATION_TARGET | typeof APP_SCOPE_PROBE_TARGET,
): boolean {
  if (request.repository.owner.toLowerCase() !== target.owner.toLowerCase()
    || request.repository.name.toLowerCase() !== target.repository.toLowerCase()
    || request.mode !== "pr"
    || request.baseRef !== target.baseRef
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

function isAppScopeDenied(response: PublisherResponse): boolean {
  if ("code" in response) return response.code === "APP_NOT_INSTALLED" || response.code === "GITHUB_PERMISSION_DENIED";
  return response.error?.code === "APP_NOT_INSTALLED" || response.error?.code === "GITHUB_PERMISSION_DENIED";
}

function withCallerCredentials(binding: PublisherBinding, callerId: string, apiKey: string): AuthorizedPublisher {
  return {
    publish: (requestJson) => binding.publish(requestJson, callerId, apiKey),
    verifyCanaryAuthorization: () => binding.verifyCanaryAuthorization(callerId, apiKey),
  };
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
