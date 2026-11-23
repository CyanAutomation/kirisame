import type { Repository } from "../contracts/types.js";

export function repositoryKey(repository: Repository): string {
  return `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
}
