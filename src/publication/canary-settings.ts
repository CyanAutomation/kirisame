import { CANARY_PUBLICATION_TARGET } from "../shared/canary-target.js";

export interface CanarySettings {
  enabled: boolean;
  repository: string;
  baseRef: string;
}

export const CANARY_PUBLISHER_BINDING = {
  worker: "kirisame",
  exportName: "PublisherEntrypoint",
  dev: { remote: true },
} as const;

export const LIVE_CANARY_PUBLISHER_BINDING = {
  worker: "kirisame",
  exportName: "PublisherEntrypoint",
} as const;

export const LIVE_CANARY_WORKFLOW = {
  name: "kirisame-live-invoker",
  exportName: "LiveCanaryWorkflow",
  maxSteps: 2,
  concurrencyLimit: 1,
  retention: "1 day",
} as const;

export const LIVE_CANARY_WORKER_EXPOSURE: {
  workersDev: false;
  previewUrls: false;
  triggers: never[];
} = {
  workersDev: false,
  previewUrls: false,
  triggers: [],
};

export function resolveCanarySettings(environment: Record<string, string | undefined>): CanarySettings {
  const repository = environment.KIRISAME_CANARY_REPOSITORY?.trim() ?? "";
  const baseRef = environment.KIRISAME_CANARY_BASE_REF?.trim() ?? "";
  const [owner, name, extra] = repository.split("/");
  const targetIsValid = owner?.toLowerCase() === CANARY_PUBLICATION_TARGET.owner.toLowerCase()
    && name?.toLowerCase() === CANARY_PUBLICATION_TARGET.repository.toLowerCase()
    && extra === undefined
    && baseRef === CANARY_PUBLICATION_TARGET.baseRef;
  const enabled = environment.KIRISAME_CANARY_ENABLED === "true" && targetIsValid;
  return {
    enabled,
    repository: enabled ? `${CANARY_PUBLICATION_TARGET.owner}/${CANARY_PUBLICATION_TARGET.repository}` : repository,
    baseRef: enabled ? CANARY_PUBLICATION_TARGET.baseRef : baseRef,
  };
}
