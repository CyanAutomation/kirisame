interface SchemaValidationError {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
}

interface SchemaValidator {
  (value: unknown): boolean;
  errors?: SchemaValidationError[] | null;
}

export const validateArtifact: SchemaValidator;
export const validateError: SchemaValidator;
export const validateEvent: SchemaValidator;
export const validateRequest: SchemaValidator;
export const validateResult: SchemaValidator;
