import { bytesToBase64, utf8 } from "../contracts/integrity.js";
import { PublicationFailure } from "../errors/publication-error.js";

export const KIRISAME_GITHUB_APP_ID = "3345400";
const MAX_JWT_LIFETIME_SECONDS = 600;

export interface GitHubAppCredentials {
  appId: string;
  clientId?: string;
  privateKey: string;
}

export function validateGitHubAppCredentials(credentials: GitHubAppCredentials): void {
  if (credentials.appId !== KIRISAME_GITHUB_APP_ID || !credentials.privateKey.trim()) {
    throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  }
  if (credentials.clientId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/u.test(credentials.clientId)) {
    throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  }
}

export async function createGitHubAppJwt(
  credentials: GitHubAppCredentials,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  validateGitHubAppCredentials(credentials);
  const key = await importGitHubAppPrivateKey(credentials.privateKey);
  const issuedAt = nowSeconds - 60;
  const expiresAt = Math.min(nowSeconds + MAX_JWT_LIFETIME_SECONDS - 60, issuedAt + MAX_JWT_LIFETIME_SECONDS);
  if (!Number.isSafeInteger(nowSeconds) || expiresAt <= nowSeconds || expiresAt - issuedAt > MAX_JWT_LIFETIME_SECONDS) {
    throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  }
  const header = base64Url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(utf8(JSON.stringify({
    iat: issuedAt,
    exp: expiresAt,
    iss: credentials.clientId ?? credentials.appId,
  })));
  const signingInput = `${header}.${payload}`;
  try {
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, asArrayBuffer(utf8(signingInput)));
    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  } catch {
    throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  }
}

export async function importGitHubAppPrivateKey(pem: string): Promise<CryptoKey> {
  const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s+([A-Za-z0-9+/=\r\n]+)\s+-----END \1-----\s*$/.exec(pem.trim());
  if (!match) throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  const encoded = match[2]!.replace(/\s+/gu, "");
  const der = canonicalBase64ToBytes(encoded);
  if (!der) throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  const keyBytes = match[1] === "RSA PRIVATE KEY" ? wrapPkcs1AsPkcs8(der) : der;
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      asArrayBuffer(keyBytes),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new Uint8Array([0]));
    return key;
  } catch {
    throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
  }
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithm = new Uint8Array([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  const privateKey = derElement(0x04, pkcs1);
  return derElement(0x30, concatenate(version, rsaAlgorithm, privateKey));
}

function derElement(tag: number, value: Uint8Array): Uint8Array {
  const length = encodeDerLength(value.byteLength);
  return concatenate(new Uint8Array([tag]), length, value);
}

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) bytes.unshift(remaining & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function canonicalBase64ToBytes(value: string): Uint8Array | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytesToBase64(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
