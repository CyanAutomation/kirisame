import { describe, expect, it } from "vitest";
import { hasConfiguredPublisherCallers, isAuthorizedPublisherCaller } from "../../src/publication/caller-auth.js";

const currentKey = "A".repeat(43);
const previousKey = "B".repeat(43);
const callers = JSON.stringify({ soyuz: [currentKey], "kirisame-live-invoker": [previousKey, currentKey] });

describe("private publisher caller authentication", () => {
  it("accepts a caller key and an overlapping rotation key without changing the request", async () => {
    await expect(isAuthorizedPublisherCaller(callers, "soyuz", currentKey)).resolves.toBe(true);
    await expect(isAuthorizedPublisherCaller(callers, "kirisame-live-invoker", previousKey)).resolves.toBe(true);
  });

  it.each([
    { label: "unknown caller", caller: "other-worker", key: currentKey },
    { label: "wrong key", caller: "soyuz", key: "C".repeat(43) },
    { label: "missing key", caller: "soyuz", key: undefined },
    { label: "malformed key", caller: "soyuz", key: "short" },
    { label: "missing caller", caller: undefined, key: currentKey },
  ])("rejects $label", async ({ caller, key }) => {
    await expect(isAuthorizedPublisherCaller(callers, caller, key)).resolves.toBe(false);
  });

  it.each([undefined, "", "not-json", "[]", JSON.stringify({ soyuz: [] }), JSON.stringify({ Soyuz: [currentKey] })])(
    "fails closed for invalid accepted-key configuration %s",
    async (configuration) => {
      await expect(isAuthorizedPublisherCaller(configuration, "soyuz", currentKey)).resolves.toBe(false);
      expect(hasConfiguredPublisherCallers(configuration)).toBe(false);
    },
  );

  it("reports readiness only when at least one valid caller key is configured", () => {
    expect(hasConfiguredPublisherCallers(callers)).toBe(true);
    expect(hasConfiguredPublisherCallers(JSON.stringify({ soyuz: ["invalid"] }))).toBe(false);
  });
});
