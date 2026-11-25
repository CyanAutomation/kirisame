const CALLER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_CALLERS = 32;
const MAX_KEYS_PER_CALLER = 2;
const MAX_KEY_CONFIGURATION_BYTES = 32 * 1024;

type CallerKeyMap = Map<string, string[]>;

/** Parse the receiver's secret JSON map. Values may contain current and previous keys during rotation. */
export function hasConfiguredPublisherCallers(configuration: unknown): boolean {
  return parseCallerKeyMap(configuration) !== undefined;
}

/** Authenticate a private RPC caller without comparing secret strings directly. */
export async function isAuthorizedPublisherCaller(
  configuration: unknown,
  callerId: unknown,
  apiKey: unknown,
): Promise<boolean> {
  if (typeof callerId !== "string" || !CALLER_ID_PATTERN.test(callerId)
    || typeof apiKey !== "string" || !API_KEY_PATTERN.test(apiKey)) return false;

  const keysByCaller = parseCallerKeyMap(configuration);
  const acceptedKeys = keysByCaller?.get(callerId);
  if (!acceptedKeys) return false;

  const candidateDigest = await sha256(apiKey);
  let matched = 0;
  for (const acceptedKey of acceptedKeys) {
    matched |= constantTimeEqual(candidateDigest, await sha256(acceptedKey)) ? 1 : 0;
  }
  return matched !== 0;
}

function parseCallerKeyMap(configuration: unknown): CallerKeyMap | undefined {
  if (typeof configuration !== "string" || configuration.length === 0
    || new TextEncoder().encode(configuration).byteLength > MAX_KEY_CONFIGURATION_BYTES) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(configuration);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_CALLERS) return undefined;
  const result = new Map<string, string[]>();
  for (const [callerId, acceptedKeys] of entries) {
    if (!CALLER_ID_PATTERN.test(callerId) || !Array.isArray(acceptedKeys)
      || acceptedKeys.length === 0 || acceptedKeys.length > MAX_KEYS_PER_CALLER
      || !acceptedKeys.every((key) => typeof key === "string" && API_KEY_PATTERN.test(key))) return undefined;
    result.set(callerId, acceptedKeys);
  }
  return result;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
