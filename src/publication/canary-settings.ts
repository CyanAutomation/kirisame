import { CANARY_PUBLICATION_TARGET } from "../shared/canary-target.js";

export interface CanarySettings {
  enabled: boolean;
  repository: string;
  baseRef: string;
  allowlist: string;
}

export const CANARY_PUBLISHER_BINDING = {
  worker: "kirisame",
  exportName: "PublisherEntrypoint",
  dev: { remote: true },
} as const;

export function resolveCanarySettings(environment: Record<string, string | undefined>): CanarySettings {
  const repository = environment.KIRISAME_CANARY_REPOSITORY?.trim() ?? "";
  const baseRef = environment.KIRISAME_CANARY_BASE_REF?.trim() ?? "";
  const [owner, name, extra] = repository.split("/");
  const targetIsValid = owner?.toLowerCase() === CANARY_PUBLICATION_TARGET.owner.toLowerCase()
    && name?.toLowerCase() === CANARY_PUBLICATION_TARGET.repository.toLowerCase()
    && extra === undefined
    && baseRef === CANARY_PUBLICATION_TARGET.baseRef;
  const enabled = environment.KIRISAME_CANARY_ENABLED === "true" && targetIsValid;
  const allowlist = enabled
    ? JSON.stringify([{
      owner: CANARY_PUBLICATION_TARGET.owner,
      repository: CANARY_PUBLICATION_TARGET.repository,
      operations: ["pr"],
      baseBranches: [CANARY_PUBLICATION_TARGET.baseRef],
    }])
    : "[]";
  return {
    enabled,
    repository: enabled ? `${CANARY_PUBLICATION_TARGET.owner}/${CANARY_PUBLICATION_TARGET.repository}` : repository,
    baseRef: enabled ? CANARY_PUBLICATION_TARGET.baseRef : baseRef,
    allowlist,
  };
}
