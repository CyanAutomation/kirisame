import type { PublicationRequest, Repository } from "../contracts/types.js";
import { PublicationFailure } from "../errors/publication-error.js";
import { repositoryKey } from "../github/repository-key.js";
import type { RepositoryAuthorizationRule } from "./allowlist.js";

export interface PublicationPolicy {
  authorize(request: PublicationRequest): Promise<void>;
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

function normalizeBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//u, "");
}
