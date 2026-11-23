import { describe, expect, it } from "vitest";
import { parseRepositoryAllowlist } from "../../src/publication/allowlist.js";

describe("repository allowlist parsing", () => {
  it("treats absent and whitespace-only configuration as an empty policy", () => {
    expect(parseRepositoryAllowlist(undefined)).toEqual([]);
    expect(parseRepositoryAllowlist("  \n")).toEqual([]);
  });

  it("normalizes duplicate operations and branches while retaining repository spelling", () => {
    expect(parseRepositoryAllowlist(JSON.stringify([{
      owner: "CyanAutomation",
      repository: "demo-app",
      operations: ["branch", "branch", "pr"],
      baseBranches: ["main", "main", "release/2026"],
    }]))).toEqual([{
      repository: { owner: "CyanAutomation", name: "demo-app" },
      operations: ["branch", "pr"],
      baseBranches: ["main", "release/2026"],
    }]);
  });

  it.each([
    { label: "invalid JSON", value: "not-json" },
    { label: "a non-array", value: JSON.stringify({ owner: "org" }) },
    { label: "an empty operation list", value: JSON.stringify([{ owner: "org", repository: "repo", operations: [], baseBranches: ["main"] }]) },
    { label: "an unsupported operation", value: JSON.stringify([{ owner: "org", repository: "repo", operations: ["delete"], baseBranches: ["main"] }]) },
    { label: "an unsafe branch ref", value: JSON.stringify([{ owner: "org", repository: "repo", operations: ["branch"], baseBranches: ["../main"] }]) },
    { label: "a locked branch ref", value: JSON.stringify([{ owner: "org", repository: "repo", operations: ["branch"], baseBranches: ["main.lock"] }]) },
    { label: "an unknown field", value: JSON.stringify([{ owner: "org", repository: "repo", operations: ["branch"], baseBranches: ["main"], extra: true }]) },
  ])("fails closed for $label", ({ value }) => {
    expect(() => parseRepositoryAllowlist(value)).toThrow(expect.objectContaining({ code: "PUBLISHING_UNAVAILABLE" }));
  });

  it("caps the number of repository rules", () => {
    const rule = { owner: "org", repository: "repo", operations: ["branch"], baseBranches: ["main"] };
    expect(() => parseRepositoryAllowlist(JSON.stringify(Array.from({ length: 101 }, () => rule))))
      .toThrow(expect.objectContaining({ code: "PUBLISHING_UNAVAILABLE" }));
  });
});
