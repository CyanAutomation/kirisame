import { describe, expect, it } from "vitest";
import { PublicationFailure } from "../../src/errors/publication-error.js";
import { runAuthorizationPreflightStage } from "../../src/publication/authorization-preflight.js";

describe("authorization preflight stage primitive", () => {
  it("returns the safe publication code and stage without exception details", async () => {
    const secret = "credential-detail-must-not-escape";
    const result = await runAuthorizationPreflightStage("private_key_pem_base64", async () => {
      const error = new PublicationFailure("PUBLISHING_UNAVAILABLE");
      error.message = secret;
      throw error;
    });

    expect(result).toEqual({
      ok: false,
      failureStage: "private_key_pem_base64",
      code: "PUBLISHING_UNAVAILABLE",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("maps unknown exceptions to INTERNAL_ERROR without exposing their messages", async () => {
    const secret = "raw-private-key-material";
    const result = await runAuthorizationPreflightStage("github_app_signing", async () => {
      throw new Error(`signing failed with ${secret}`);
    });

    expect(result).toEqual({
      ok: false,
      failureStage: "github_app_signing",
      code: "INTERNAL_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not include operation return values in its safe outcome", async () => {
    const result = await runAuthorizationPreflightStage("installation_and_token_scope", () => {
      return "token-value-must-not-escape";
    });

    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain("token-value-must-not-escape");
  });
});
