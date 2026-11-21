import canonicalize from "canonicalize";

export function canonicalizeJson(value: unknown): string | undefined {
  return canonicalize(value);
}
