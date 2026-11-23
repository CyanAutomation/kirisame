export interface CanarySettings {
  enabled: boolean;
  repository: string;
  baseRef: string;
  allowlist: string;
}

export function resolveCanarySettings(environment: Record<string, string | undefined>): CanarySettings {
  const repository = environment.KIRISAME_CANARY_REPOSITORY?.trim() ?? "";
  const baseRef = environment.KIRISAME_CANARY_BASE_REF?.trim() ?? "";
  const [owner, name, extra] = repository.split("/");
  const targetIsValid = Boolean(owner && name && extra === undefined && baseRef);
  const enabled = environment.KIRISAME_CANARY_ENABLED === "true" && targetIsValid;
  const allowlist = enabled && owner && name
    ? JSON.stringify([{ owner, repository: name, operations: ["pr"], baseBranches: [baseRef] }])
    : "[]";
  return { enabled, repository, baseRef, allowlist };
}
