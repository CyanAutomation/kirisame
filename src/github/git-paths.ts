import { PublicationFailure } from "../errors/publication-error.js";

export function validateGitObjectPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  }
}
