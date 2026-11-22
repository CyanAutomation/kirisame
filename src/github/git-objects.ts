import { bytesToHex, sha1Hex, utf8 } from "../contracts/integrity.js";
import type { GitTreeEntry } from "./types.js";

export async function gitBlobSha(content: Uint8Array): Promise<string> {
  return gitObjectSha("blob", content);
}

export async function gitCommitSha(content: Uint8Array): Promise<string> {
  return gitObjectSha("commit", content);
}

export async function gitTreeSha(entries: GitTreeEntry[]): Promise<string> {
  const ordered = [...entries].sort((left, right) => compareGitTreeNames(
    left.path + (left.type === "tree" ? "/" : ""),
    right.path + (right.type === "tree" ? "/" : ""),
  ));
  const pieces: Uint8Array[] = [];
  let length = 0;
  for (const entry of ordered) {
    if (entry.path.includes("/") || !/^[0-9a-f]{40}$/.test(entry.sha)) {
      throw new TypeError("Git tree entries must be immediate children with valid SHA-1 object IDs");
    }
    const mode = entry.mode === "040000" ? "40000" : entry.mode;
    const prefix = utf8(`${mode} ${entry.path}\0`);
    const objectId = hexToBytes(entry.sha);
    pieces.push(prefix, objectId);
    length += prefix.byteLength + objectId.byteLength;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) {
    body.set(piece, offset);
    offset += piece.byteLength;
  }
  return gitObjectSha("tree", body);
}

export function validGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function compareGitTreeNames(left: string, right: string): number {
  const a = utf8(left);
  const b = utf8(right);
  const length = Math.min(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.byteLength - b.byteLength;
}

async function gitObjectSha(type: "blob" | "tree" | "commit", body: Uint8Array): Promise<string> {
  const header = utf8(`${type} ${body.byteLength}\0`);
  const canonical = new Uint8Array(header.byteLength + body.byteLength);
  canonical.set(header);
  canonical.set(body, header.byteLength);
  return sha1Hex(canonical);
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export { bytesToHex };
