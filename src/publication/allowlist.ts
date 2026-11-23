import type { PublicationRequest, Repository } from "../contracts/types.js";
import { PublicationFailure } from "../errors/publication-error.js";

export interface RepositoryAuthorizationRule {
  repository: Repository;
  operations: PublicationRequest["mode"][];
  baseBranches: string[];
}

export function parseRepositoryAllowlist(value: string | undefined): RepositoryAuthorizationRule[] {
  if (!value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 100) throw new TypeError("invalid allowlist");
    return parsed.map((item): RepositoryAuthorizationRule => {
      if (!isRecord(item) || Object.keys(item).sort().join(",") !== "baseBranches,operations,owner,repository") {
        throw new TypeError("invalid allowlist rule");
      }
      const { owner, repository, operations, baseBranches } = item;
      if (typeof owner !== "string" || typeof repository !== "string"
        || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/iu.test(owner)
        || !/^[a-z0-9](?:[a-z0-9._-]{0,97}[a-z0-9])?$/iu.test(repository)
        || !Array.isArray(operations) || operations.length === 0
        || operations.some((operation) => operation !== "branch" && operation !== "pr")
        || !Array.isArray(baseBranches) || baseBranches.length === 0
        || baseBranches.some((branch) => typeof branch !== "string" || !isValidBranch(branch))) {
        throw new TypeError("invalid allowlist rule");
      }
      return {
        repository: { owner, name: repository },
        operations: [...new Set(operations as PublicationRequest["mode"][])],
        baseBranches: [...new Set(baseBranches as string[])],
      };
    });
  } catch {
    throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  }
}

function isValidBranch(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)*$/u.test(value)
    && !value.includes("..") && !value.includes("@{") && !value.split("/").some((part) => part.endsWith(".lock"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
