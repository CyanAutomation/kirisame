import type { PublicationRequest, Repository } from "../contracts/types.js";
import { PublicationFailure } from "../errors/publication-error.js";

export interface PublicationPolicy {
  authorize(request: PublicationRequest): Promise<void>;
}

/** Explicit repository and operation policy used by tests and future production policy wiring. */
export class AllowlistedPublicationPolicy implements PublicationPolicy {
  readonly #repositories: Set<string>;
  readonly #modes: Set<PublicationRequest["mode"]>;

  constructor(repositories: Repository[], modes: PublicationRequest["mode"][] = ["branch", "pr"]) {
    this.#repositories = new Set(repositories.map(repositoryKey));
    this.#modes = new Set(modes);
  }

  async authorize(request: PublicationRequest): Promise<void> {
    if (!this.#repositories.has(repositoryKey(request.repository))) throw new PublicationFailure("REPOSITORY_NOT_ALLOWED");
    if (!this.#modes.has(request.mode)) throw new PublicationFailure("UNAUTHORIZED_CALLER");
  }
}

export function repositoryKey(repository: Repository): string {
  return `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
}
