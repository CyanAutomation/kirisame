import type { PublicationRequest, Repository } from "../contracts/types.js";
import { PublicationFailure } from "../errors/publication-error.js";

export interface PublicationPolicy {
  authorize(request: PublicationRequest): Promise<void>;
}

export interface RepositoryAuthorizationRule {
  repository: Repository;
  operations: PublicationRequest["mode"][];
  baseBranches: string[];
}

/** Explicit repository and operation policy used by tests and future production policy wiring. */
export class AllowlistedPublicationPolicy implements PublicationPolicy {
  readonly #repositories: Set<string>;
  readonly #modes: Set<PublicationRequest["mode"]>;
  readonly #baseBranches: Set<string>;

  constructor(
    repositories: Repository[],
    modes: PublicationRequest["mode"][] = ["branch", "pr"],
    baseBranches: string[] = ["main"],
  ) {
    this.#repositories = new Set(repositories.map(repositoryKey));
    this.#modes = new Set(modes);
    this.#baseBranches = new Set(baseBranches);
  }

  async authorize(request: PublicationRequest): Promise<void> {
    if (!this.#repositories.has(repositoryKey(request.repository))) throw new PublicationFailure("REPOSITORY_NOT_ALLOWED");
    if (!this.#modes.has(request.mode)) throw new PublicationFailure("UNAUTHORIZED_CALLER");
    if (!this.#baseBranches.has(normalizeBranch(request.baseRef))) throw new PublicationFailure("UNAUTHORIZED_CALLER");
  }
}

export class RepositoryAllowlistPolicy implements PublicationPolicy {
  readonly #rules: Map<string, { operations: Set<PublicationRequest["mode"]>; baseBranches: Set<string> }>;

  constructor(rules: RepositoryAuthorizationRule[]) {
    this.#rules = new Map(rules.map((rule) => [repositoryKey(rule.repository), {
      operations: new Set(rule.operations),
      baseBranches: new Set(rule.baseBranches.map(normalizeBranch)),
    }]));
  }

  async authorize(request: PublicationRequest): Promise<void> {
    const rule = this.#rules.get(repositoryKey(request.repository));
    if (!rule) throw new PublicationFailure("REPOSITORY_NOT_ALLOWED");
    if (!rule.operations.has(request.mode) || !rule.baseBranches.has(normalizeBranch(request.baseRef))) {
      throw new PublicationFailure("UNAUTHORIZED_CALLER");
    }
  }
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

export function repositoryKey(repository: Repository): string {
  return `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
}

export function normalizeBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//u, "");
}

function isValidBranch(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)*$/u.test(value)
    && !value.includes("..") && !value.includes("@{") && !value.split("/").some((part) => part.endsWith(".lock"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
