import { bytesToBase64 } from "../../src/contracts/integrity.js";
import type { GitHubAppCredentials } from "../../src/github/GitHubAppAuth.js";

export interface TestGitHubAppKeys {
  credentials: GitHubAppCredentials;
  publicKey: CryptoKey;
  pkcs8Pem: string;
}

export async function generateTestGitHubAppKeys(): Promise<TestGitHubAppKeys> {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const pkcs1 = sequence([
    integer(new Uint8Array([0])),
    ...(["n", "e", "d", "p", "q", "dp", "dq", "qi"] as const).map((field) => integer(decodeBase64Url(privateJwk[field]!))),
  ]);
  const pkcs1Pem = pem("RSA PRIVATE KEY", pkcs1);
  return {
    credentials: { appId: "3345400", clientId: "Iv1.test-client", privateKey: pkcs1Pem },
    publicKey: pair.publicKey,
    pkcs8Pem: pem("PRIVATE KEY", pkcs8),
  };
}

export function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function integer(value: Uint8Array): Uint8Array {
  let first = 0;
  while (first < value.length - 1 && value[first] === 0) first += 1;
  const payload = value.slice(first);
  const signed = payload[0]! & 0x80 ? concat(new Uint8Array([0]), payload) : payload;
  return der(0x02, signed);
}

function sequence(values: Uint8Array[]): Uint8Array {
  return der(0x30, concat(...values));
}

function der(tag: number, value: Uint8Array): Uint8Array {
  const length = value.length < 0x80
    ? new Uint8Array([value.length])
    : encodeLongLength(value.length);
  return concat(new Uint8Array([tag]), length, value);
}

function encodeLongLength(value: number): Uint8Array {
  const bytes: number[] = [];
  for (let current = value; current > 0; current >>>= 8) bytes.unshift(current & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function pem(label: string, derBytes: Uint8Array): string {
  const base64 = bytesToBase64(derBytes);
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}
