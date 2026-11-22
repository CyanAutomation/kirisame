import { beforeAll, describe, expect, it } from "vitest";
import { utf8 } from "../../src/contracts/integrity.js";
import { createGitHubAppJwt, importGitHubAppPrivateKey, validateGitHubAppCredentials } from "../../src/github/GitHubAppAuth.js";
import { generateTestGitHubAppKeys, decodeBase64Url, type TestGitHubAppKeys } from "./github-test-utils.js";

let keys: TestGitHubAppKeys;

beforeAll(async () => {
  keys = await generateTestGitHubAppKeys();
});

describe("GitHub App JWT signing", () => {
  it("generates an RS256 JWT with a supported issuer and skew-safe time claims", async () => {
    const now = 1_800_000_000;
    const token = await createGitHubAppJwt(keys.credentials, now);
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(headerPart!))) as Record<string, unknown>;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payloadPart!))) as Record<string, unknown>;
    const signature = decodeBase64Url(signaturePart!);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keys.publicKey,
      asArrayBuffer(signature),
      asArrayBuffer(utf8(`${headerPart}.${payloadPart}`)),
    );

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims).toEqual({ iat: now - 60, exp: now + 540, iss: "Iv1.test-client" });
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);
    expect(valid).toBe(true);
    expect(token).not.toContain("PRIVATE KEY");
  });

  it("uses the numeric App ID as a supported issuer when no Client ID is configured", async () => {
    const token = await createGitHubAppJwt({ appId: "3345400", privateKey: keys.credentials.privateKey }, 1_800_000_000);
    const payload = token.split(".")[1]!;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as Record<string, unknown>;
    expect(claims.iss).toBe("3345400");
  });

  it("imports both GitHub traditional RSA PEM and unencrypted PKCS#8 PEM keys", async () => {
    const pkcs1 = await importGitHubAppPrivateKey(keys.credentials.privateKey);
    const pkcs8 = await importGitHubAppPrivateKey(keys.pkcs8Pem);
    expect(pkcs1.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
    expect(pkcs8.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
  });

  it("rejects missing, inconsistent, encrypted, and malformed signing configuration", async () => {
    expect(() => validateGitHubAppCredentials({ appId: "", privateKey: keys.credentials.privateKey })).toThrow();
    expect(() => validateGitHubAppCredentials({ appId: "999", privateKey: keys.credentials.privateKey })).toThrow();
    await expect(importGitHubAppPrivateKey("-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc\n-----END ENCRYPTED PRIVATE KEY-----"))
      .rejects.toMatchObject({ code: "PUBLISHING_UNAVAILABLE" });
    await expect(importGitHubAppPrivateKey("not a pem key"))
      .rejects.toMatchObject({ code: "PUBLISHING_UNAVAILABLE" });
  });

  it("uses bounded time claims and rejects an invalid clock value", async () => {
    await expect(createGitHubAppJwt(keys.credentials, Number.NaN))
      .rejects.toMatchObject({ code: "PUBLISHING_UNAVAILABLE" });
    const jwt = await createGitHubAppJwt(keys.credentials, 1_800_000_000);
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(jwt.split(".")[1]!))) as { iat: number; exp: number };
    expect(claims.exp).toBeLessThanOrEqual(1_800_000_600);
    expect(claims.iat).toBeGreaterThanOrEqual(1_799_999_900);
  });

  it("keeps signing errors generic and does not expose credential text", async () => {
    const privateText = "-----BEGIN RSA PRIVATE KEY-----";
    await expect(createGitHubAppJwt({ appId: "3345400", privateKey: privateText }, 1_800_000_000))
      .rejects.toMatchObject({ code: "PUBLISHING_UNAVAILABLE" });
    try {
      await importGitHubAppPrivateKey(privateText);
    } catch (error) {
      expect((error as Error).message).not.toContain(privateText);
    }
  });
});

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
