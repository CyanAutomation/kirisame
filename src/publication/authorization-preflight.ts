import type { CanaryAuthorizationFailureStage, PublicationErrorCode } from "../contracts/types.js";
import { asPublicationFailure } from "../errors/publication-error.js";

export type AuthorizationPreflightStageResult =
  | { ok: true }
  | { ok: false; failureStage: CanaryAuthorizationFailureStage; code: PublicationErrorCode };

/** Runs one preflight step and returns only its stage and stable error code. */
export async function runAuthorizationPreflightStage(
  failureStage: CanaryAuthorizationFailureStage,
  operation: () => unknown | Promise<unknown>,
): Promise<AuthorizationPreflightStageResult> {
  try {
    await operation();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      failureStage,
      code: asPublicationFailure(error).code,
    };
  }
}
