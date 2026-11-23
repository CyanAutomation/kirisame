import { describe, expect, it } from "vitest";
import type { GitTreeEntry } from "../../src/github/types.js";
import { utf8 } from "../../src/contracts/integrity.js";
import { PublicationFailure } from "../../src/errors/publication-error.js";
import { isAttributesPath, rejectLfsGovernedChanges } from "../../src/publication/git-attributes.js";

function attributeEntry(path: string, sha: string, text: string): { entry: GitTreeEntry; bytes: Uint8Array } {
  return { entry: { path, mode: "100644", type: "blob", sha }, bytes: utf8(text) };
}

async function checkAttributes(
  attributes: Array<{ entry: GitTreeEntry; bytes: Uint8Array }>,
  changedPaths: string[],
): Promise<void> {
  const blobs = new Map(attributes.map(({ entry, bytes }) => [entry.sha, bytes]));
  await rejectLfsGovernedChanges(
    attributes.map(({ entry }) => entry),
    changedPaths,
    async (sha) => blobs.get(sha),
  );
}

describe("Git attributes validation", () => {
  it("recognizes root and nested attributes files case-insensitively", () => {
    expect(isAttributesPath(".gitattributes")).toBe(true);
    expect(isAttributesPath("docs/.gitattributes")).toBe(true);
    expect(isAttributesPath("docs/README.md")).toBe(false);
  });

  it("rejects changed files covered by root or nested LFS filters", async () => {
    const root = attributeEntry(".gitattributes", "a".repeat(40), "*.bin filter=lfs\n");
    const nested = attributeEntry("docs/.gitattributes", "b".repeat(40), "*.md filter=lfs\n");

    await expect(checkAttributes([root], ["archive.bin"]))
      .rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });
    await expect(checkAttributes([nested], ["docs/guide.md"]))
      .rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });
    await expect(checkAttributes([nested], ["other/guide.md"])).resolves.toBeUndefined();
  });

  it("applies more specific nested rules after root rules regardless of tree entry order", async () => {
    const root = attributeEntry(".gitattributes", "a".repeat(40), "*.md filter=lfs\n");
    const nested = attributeEntry("docs/.gitattributes", "b".repeat(40), "*.md -filter\n");

    await expect(checkAttributes([nested, root], ["docs/guide.md"])).resolves.toBeUndefined();
    await expect(checkAttributes([nested, root], ["README.md"]))
      .rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });
  });

  it("accepts supported attributes and later filter removal, but fails closed on unsupported attributes", async () => {
    const supported = attributeEntry(".gitattributes", "a".repeat(40), "*.txt text eol=lf\n*.txt -filter\n");
    await expect(checkAttributes([supported], ["docs/readme.txt"])).resolves.toBeUndefined();

    const unsupported = attributeEntry(".gitattributes", "b".repeat(40), "*.txt working-tree-encoding=UTF-16\n");
    await expect(checkAttributes([unsupported], ["readme.txt"]))
      .rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });
  });

  it.each([
    { label: "invalid UTF-8", bytes: Uint8Array.of(0xff) },
    { label: "control characters", bytes: utf8("*.txt filter=lfs\u0001\n") },
    { label: "unsupported glob syntax", bytes: utf8("**/*.txt filter=lfs\n") },
  ])("rejects $label", async ({ bytes }) => {
    const entry: GitTreeEntry = { path: ".gitattributes", mode: "100644", type: "blob", sha: "a".repeat(40) };
    await expect(rejectLfsGovernedChanges([entry], ["readme.txt"], async () => bytes))
      .rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });
  });

  it("enforces aggregate rule and blob limits", async () => {
    const manyRules = attributeEntry(".gitattributes", "a".repeat(40), "*.txt text\n".repeat(4097));
    await expect(checkAttributes([manyRules], [])).rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });

    const tooLarge = attributeEntry(".gitattributes", "b".repeat(40), "x".repeat(64 * 1024 + 1));
    await expect(checkAttributes([tooLarge], [])).rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });

    const largeFiles = [0, 1, 2].map((index) => attributeEntry(
      `dir-${index}/.gitattributes`,
      String(index + 1).repeat(40),
      `#${"x".repeat(64 * 1024 - 1)}`,
    ));
    await expect(checkAttributes(largeFiles, [])).rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });

    const tooManyFiles = Array.from({ length: 101 }, (_, index) => attributeEntry(
      `dir-${index}/.gitattributes`,
      index.toString(16).padStart(40, "0"),
      "# generated fixture\n",
    ));
    await expect(checkAttributes(tooManyFiles, [])).rejects.toMatchObject({ code: "UNSUPPORTED_GIT_OBJECT" });

    const missingBlob: GitTreeEntry = { path: ".gitattributes", mode: "100644", type: "blob", sha: "c".repeat(40) };
    await expect(rejectLfsGovernedChanges([missingBlob], [], async () => undefined))
      .rejects.toBeInstanceOf(PublicationFailure);
  });
});
