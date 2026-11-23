import { describe, expect, it } from "vitest";
import { resolveCanarySettings } from "../../src/publication/canary-settings.js";

describe("resolveCanarySettings", () => {
  it("enables a canary only for one approved repository and a pinned base", () => {
    const settings = resolveCanarySettings({
      KIRISAME_CANARY_ENABLED: "true",
      KIRISAME_CANARY_REPOSITORY: " CyanAutomation/demo-app ",
      KIRISAME_CANARY_BASE_REF: " main ",
    });

    expect(settings).toEqual({
      enabled: true,
      repository: "CyanAutomation/demo-app",
      baseRef: "main",
      allowlist: JSON.stringify([{
        owner: "CyanAutomation",
        repository: "demo-app",
        operations: ["pr"],
        baseBranches: ["main"],
      }]),
    });
  });

  it.each([
    { label: "disabled flag", environment: { KIRISAME_CANARY_ENABLED: "false", KIRISAME_CANARY_REPOSITORY: "CyanAutomation/demo-app", KIRISAME_CANARY_BASE_REF: "main" } },
    { label: "missing base", environment: { KIRISAME_CANARY_ENABLED: "true", KIRISAME_CANARY_REPOSITORY: "CyanAutomation/demo-app" } },
    { label: "multiple repository segments", environment: { KIRISAME_CANARY_ENABLED: "true", KIRISAME_CANARY_REPOSITORY: "CyanAutomation/demo-app/extra", KIRISAME_CANARY_BASE_REF: "main" } },
  ])("keeps publishing disabled for $label", ({ environment }) => {
    const settings = resolveCanarySettings(environment);

    expect(settings.enabled).toBe(false);
    expect(settings.allowlist).toBe("[]");
  });
});
