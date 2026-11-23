import { PublicationFailure } from "../errors/publication-error.js";
import type { GitTreeEntry } from "../github/types.js";

const MAX_ATTRIBUTE_FILE_BYTES = 64 * 1024;
const MAX_ATTRIBUTE_FILES = 100;
const MAX_ATTRIBUTE_RULES = 4096;
const SUPPORTED_NON_FILTER_ATTRIBUTES = new Set([
  "text", "eol", "diff", "merge", "ident", "export-ignore", "export-subst",
  "linguist-generated", "linguist-language", "linguist-vendored", "linguist-detectable",
]);

interface AttributeRule {
  scope: string;
  pattern: RegExp;
  attributes: Array<{ name: string; value: string | null }>;
}

export async function rejectLfsGovernedChanges(
  entries: GitTreeEntry[],
  changedPaths: string[],
  readBlob: (sha: string) => Promise<Uint8Array | undefined>,
): Promise<void> {
  const rules = await readAttributeRules(entries, readBlob);
  for (const changedPath of changedPaths) {
    if (activeFilterForPath(changedPath, rules) !== null) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  }
}

async function readAttributeRules(
  entries: GitTreeEntry[],
  readBlob: (sha: string) => Promise<Uint8Array | undefined>,
): Promise<AttributeRule[]> {
  const attributeEntries = entries
    .filter((entry) => entry.type === "blob" && isAttributesPath(entry.path))
    .sort((left, right) => attributeScopeDepth(left.path) - attributeScopeDepth(right.path));
  if (attributeEntries.length > MAX_ATTRIBUTE_FILES) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");

  const rules: AttributeRule[] = [];
  let totalBytes = 0;
  for (const entry of attributeEntries) {
    const content = await readBlob(entry.sha);
    if (!content || content.byteLength > MAX_ATTRIBUTE_FILE_BYTES) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    totalBytes += content.byteLength;
    if (totalBytes > MAX_ATTRIBUTE_FILE_BYTES * 2) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    rules.push(...parseAttributeFile(entry.path, content));
    if (rules.length > MAX_ATTRIBUTE_RULES) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  }
  return rules;
}

function activeFilterForPath(changedPath: string, rules: AttributeRule[]): string | null {
  let activeFilter: string | null = null;
  for (const rule of rules) {
    const relativePath = relativeToScope(changedPath, rule.scope);
    if (relativePath === undefined || !rule.pattern.test(relativePath)) continue;
    for (const attribute of rule.attributes) {
      if (attribute.name === "filter") {
        activeFilter = attribute.value;
      } else if (!SUPPORTED_NON_FILTER_ATTRIBUTES.has(attribute.name)) {
        throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
      }
    }
  }
  return activeFilter;
}

export function isAttributesPath(path: string): boolean {
  return path.toLowerCase() === ".gitattributes" || path.toLowerCase().endsWith("/.gitattributes");
}

function parseAttributeFile(path: string, bytes: Uint8Array): AttributeRule[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  }
  if (text.includes("\0") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  }

  const scope = attributeScope(path);
  const rules: AttributeRule[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const rule = parseAttributeLine(rawLine, scope);
    if (rule) rules.push(rule);
  }
  return rules;
}

function parseAttributeLine(rawLine: string, scope: string): AttributeRule | undefined {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return undefined;
  const tokens = line.split(/\s+/u);
  const rawPattern = tokens.shift();
  if (!rawPattern || tokens.length === 0 || rawPattern.startsWith("!") || rawPattern.includes("\\")) {
    throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  }
  return { scope, pattern: compilePattern(rawPattern), attributes: tokens.map(parseAttribute) };
}

function attributeScope(path: string): string {
  return path.toLowerCase() === ".gitattributes" ? "" : path.slice(0, -"/.gitattributes".length);
}

function attributeScopeDepth(path: string): number {
  const scope = attributeScope(path);
  return scope ? scope.split("/").length : 0;
}

function compilePattern(pattern: string): RegExp {
  if (pattern.startsWith("/") || pattern.endsWith("/") || pattern.includes("**") || /[\[\]]/u.test(pattern)) {
    throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  }
  if (!/^[A-Za-z0-9._/*?+-]+$/u.test(pattern)) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  const source = [...pattern].map((character) => {
    if (character === "*") return "[^/]*";
    if (character === "?") return "[^/]";
    return character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }).join("");
  const expression = pattern.includes("/")
    ? `^${source}$`
    : `(?:^|/)${source}$`;
  return new RegExp(expression, "u");
}

function parseAttribute(token: string): { name: string; value: string | null } {
  if (token.startsWith("-")) return { name: token.slice(1), value: null };
  if (token.startsWith("!")) return { name: token.slice(1), value: null };
  const separator = token.indexOf("=");
  const name = separator === -1 ? token : token.slice(0, separator);
  const value = separator === -1 ? "set" : token.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/u.test(name) || value === "") throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  return { name, value };
}

function relativeToScope(path: string, scope: string): string | undefined {
  if (!scope) return path;
  if (!path.startsWith(`${scope}/`)) return undefined;
  return path.slice(scope.length + 1);
}
