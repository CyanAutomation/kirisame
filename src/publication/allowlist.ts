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
    return parseRules(JSON.parse(value));
  } catch {
    throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  }
}

function parseRules(value: unknown): RepositoryAuthorizationRule[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError("invalid allowlist");
  return value.map(parseRule);
}

function parseRule(value: unknown): RepositoryAuthorizationRule {
  if (!hasExpectedRuleShape(value)) throw new TypeError("invalid allowlist rule");
  const { owner, repository, operations, baseBranches } = value;
  if (typeof owner !== "string" || typeof repository !== "string"
    || !isValidOwner(owner) || !isValidRepositoryName(repository)
    || !isValidOperations(operations) || !isValidBaseBranches(baseBranches)) {
    throw new TypeError("invalid allowlist rule");
  }
  return {
    repository: { owner, name: repository },
    operations: [...new Set(operations)],
    baseBranches: [...new Set(baseBranches)],
  };
}

function hasExpectedRuleShape(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(",") === "baseBranches,operations,owner,repository";
}

function isValidOwner(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/iu.test(value);
}

function isValidRepositoryName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]{0,97}[a-z0-9])?$/iu.test(value);
}

function isValidOperations(value: unknown): value is PublicationRequest["mode"][] {
  return Array.isArray(value) && value.length > 0
    && value.every((operation) => operation === "branch" || operation === "pr");
}

function isValidBaseBranches(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every((branch) => typeof branch === "string" && isValidBranch(branch));
}

function isValidBranch(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)*$/u.test(value)
    && !value.includes("..") && !value.includes("@{") && !value.split("/").some((part) => part.endsWith(".lock"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
