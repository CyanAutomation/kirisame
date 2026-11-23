import { PublicationFailure } from "../errors/publication-error.js";
import type { GitHubOperation } from "./types.js";

export interface MockFault {
  code: "GITHUB_AUTH_UNAVAILABLE" | "GITHUB_AUTH_INVALID" | "GITHUB_PERMISSION_DENIED" | "REPOSITORY_NOT_ALLOWED"
    | "BRANCH_CONFLICT" | "BASE_MOVED" | "GITHUB_RATE_LIMITED" | "GITHUB_TIMEOUT"
    | "GITHUB_UNAVAILABLE" | "PULL_REQUEST_CONFLICT" | "TREE_TRUNCATED" | "API_CONFLICT"
    | "PR_LIST_INCOMPLETE" | "UNSUPPORTED_GIT_OBJECT";
  afterMutation?: boolean;
  retryAfterSeconds?: number;
  skip?: number;
  times?: number;
}

export function mockFaultFailure(operation: GitHubOperation, fault: MockFault): PublicationFailure {
  if (fault.code === "TREE_TRUNCATED") return new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  if (fault.code === "API_CONFLICT") return new PublicationFailure(apiConflictCode(operation));
  if (fault.code === "PR_LIST_INCOMPLETE") return new PublicationFailure("GITHUB_UNAVAILABLE");
  const options = fault.code === "GITHUB_RATE_LIMITED" ? { retryAfterSeconds: fault.retryAfterSeconds ?? 60 } : {};
  return new PublicationFailure(fault.code, options);
}

export function skipMockFaultCall(fault: MockFault): boolean {
  const remaining = fault.skip ?? 0;
  if (remaining <= 0) return false;
  fault.skip = remaining - 1;
  return true;
}

function apiConflictCode(operation: GitHubOperation): "BRANCH_CONFLICT" | "PULL_REQUEST_CONFLICT" | "BASE_TREE_CONFLICT" {
  if (operation === "createRef") return "BRANCH_CONFLICT";
  if (operation === "createPullRequest") return "PULL_REQUEST_CONFLICT";
  return "BASE_TREE_CONFLICT";
}
