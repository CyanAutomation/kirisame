import {
  validateArtifact,
  validateError,
  validateEvent,
  validateRequest,
  validateResult,
} from "./generated.js";
import { semanticErrors, validateResultForRequest } from "./semantic.js";
import type { ContractType, ValidationIssue, ValidationResult } from "./types.js";

const validators = {
  "publication-artifact": validateArtifact,
  "publication-error": validateError,
  "publication-event": validateEvent,
  "publication-request": validateRequest,
  "publication-result": validateResult,
} satisfies Record<ContractType, (value: unknown) => boolean>;

export async function validateContract(type: ContractType, document: unknown): Promise<ValidationResult> {
  const validateSchema = validators[type];
  if (!validateSchema(document)) {
    const errors = (validateSchema as typeof validateSchema & { errors?: Array<{ keyword?: string; instancePath?: string; params?: Record<string, unknown> }> }).errors ?? [];
    return {
      valid: false,
      errors: errors.map((error) => ({
        source: "schema" as const,
        keyword: error.keyword,
        instancePath: error.instancePath,
        params: error.params,
      })),
    };
  }
  const errors = await semanticErrors(type, document);
  return { valid: errors.length === 0, errors };
}

export async function validateResultAgainstRequest(request: unknown, result: unknown): Promise<ValidationIssue[]> {
  const requestValidation = await validateContract("publication-request", request);
  const resultValidation = await validateContract("publication-result", result);
  return [...requestValidation.errors, ...resultValidation.errors, ...await validateResultForRequest(request, result)];
}
