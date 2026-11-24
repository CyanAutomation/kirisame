import { bytesToBase64 } from "../contracts/integrity.js";
import type { Repository } from "../contracts/types.js";
import { PublicationFailure } from "../errors/publication-error.js";
import { createGitHubAppJwt, type GitHubAppCredentials, validateGitHubAppCredentials } from "./GitHubAppAuth.js";
import { gitBlobSha, validGitSha } from "./git-objects.js";
import { repositoryKey } from "./repository-key.js";
import { validateGitObjectPath } from "./git-paths.js";
import type { GitHubAdapter } from "./GitHubAdapter.js";
import { readLimitedBytes } from "../shared/streams.js";
import type {
  CreateCommitInput,
  CreatePullRequestInput,
  GitCommit,
  GitTreeEntry,
  GitTreeUpdate,
  PullRequestRecord,
  RepositoryIdentity,
} from "./types.js";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 32 * 1024;
const MAX_TREE_ENTRIES = 50_000;
const MAX_TREE_DEPTH = 64;
const MAX_PR_PAGES = 20;

export interface RealGitHubAdapterOptions {
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
}

interface JsonResponse {
  data: unknown;
  headers: Headers;
  status: number;
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  token: string;
  allowNotFound?: boolean;
  notFoundCode?: "APP_NOT_INSTALLED" | "GITHUB_UNAVAILABLE";
  conflictCode?: "BASE_TREE_CONFLICT" | "BRANCH_CONFLICT" | "PULL_REQUEST_CONFLICT";
  unprocessableCode?: "BASE_TREE_CONFLICT" | "BRANCH_CONFLICT" | "PULL_REQUEST_CONFLICT";
  maxBytes?: number;
}

interface InstallationTokenResponse {
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
  repositories: Array<{ id: number; fullName: string }>;
}

export class RealGitHubAdapter implements GitHubAdapter {
  readonly #credentials: GitHubAppCredentials;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;
  #installationToken: string | undefined;
  #tokenExpiresAt = 0;
  #authorizedRepositoryKey: string | undefined;
  #authorizedOperation: "branch" | "pr" | undefined;
  #identity: RepositoryIdentity | undefined;

  constructor(credentials: GitHubAppCredentials, options: RealGitHubAdapterOptions = {}) {
    validateGitHubAppCredentials(credentials);
    this.#credentials = credentials;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 100 || this.#requestTimeoutMs > 30_000) {
      throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
    }
  }

  async resolveRepository(repository: Repository, operation: "branch" | "pr"): Promise<RepositoryIdentity> {
    this.#installationToken = undefined;
    this.#tokenExpiresAt = 0;
    this.#identity = undefined;
    const key = repositoryKey(repository);
    const appJwt = await createGitHubAppJwt(this.#credentials, Math.floor(this.#now() / 1000));
    const installationPath = `${repoApiPath(repository)}/installation`;
    const installationResponse = await this.#request(installationPath, {
      token: appJwt,
      allowNotFound: true,
      notFoundCode: "APP_NOT_INSTALLED",
    });
    if (!installationResponse) throw new PublicationFailure("APP_NOT_INSTALLED");
    const installation = parseInstallation(installationResponse.data, repository, this.#credentials.appId);
    assertInstallationPermissions(installation.permissions, operation);

    const permissions: Record<string, string> = { contents: "write" };
    if (operation === "pr") permissions.pull_requests = "write";
    const tokenResponse = await this.#request(`/app/installations/${installation.id}/access_tokens`, {
      method: "POST",
      token: appJwt,
      body: { repositories: [repository.name], permissions },
      notFoundCode: "APP_NOT_INSTALLED",
    });
    const issuedToken = parseInstallationToken(tokenResponse.data, repository, permissions, this.#now());
    this.#installationToken = issuedToken.token;
    this.#tokenExpiresAt = issuedToken.expiresAt;
    this.#authorizedRepositoryKey = key;
    this.#authorizedOperation = operation;

    const repositoryResponse = await this.#request(repoApiPath(repository), {
      token: this.#installationToken,
      notFoundCode: "APP_NOT_INSTALLED",
    });
    const identity = parseRepositoryIdentity(repositoryResponse.data, repository, installation.id);
    if (identity.id !== issuedToken.repositories[0]?.id) throw new PublicationFailure("APP_NOT_INSTALLED");
    this.#identity = identity;
    return { ...identity };
  }

  async readRef(repository: Repository, ref: string): Promise<string | undefined> {
    const branch = normalizeBranchRef(ref);
    const path = `${repoApiPath(repository)}/git/ref/heads/${encodeBranchPath(branch)}`;
    const result = await this.#request(path, { token: this.#token(repository), allowNotFound: true });
    if (!result) return undefined;
    const record = asRecord(result.data);
    const sha = asRecord(record.object).sha;
    const returnedRef = record.ref;
    if (typeof returnedRef !== "string" || returnedRef !== `refs/heads/${branch}` || typeof sha !== "string" || !validGitSha(sha)) {
      throw new PublicationFailure("GITHUB_UNAVAILABLE");
    }
    return sha;
  }

  async readCommit(repository: Repository, sha: string): Promise<GitCommit | undefined> {
    if (!validGitSha(sha)) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    const result = await this.#request(`${repoApiPath(repository)}/git/commits/${sha}`, {
      token: this.#token(repository), allowNotFound: true,
    });
    if (!result) return undefined;
    return parseGitCommit(result.data, sha);
  }

  async readTree(repository: Repository, treeSha: string): Promise<GitTreeEntry[]> {
    if (!validGitSha(treeSha)) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    return this.#readTreeRecursive(repository, treeSha, "", 0, { count: 0 });
  }

  async readBlob(repository: Repository, sha: string): Promise<Uint8Array | undefined> {
    if (!validGitSha(sha)) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    const result = await this.#request(`${repoApiPath(repository)}/git/blobs/${sha}`, {
      token: this.#token(repository), allowNotFound: true, maxBytes: 2 * 1024 * 1024,
    });
    if (!result) return undefined;
    return decodeGitHubBlob(result.data, sha);
  }

  async createBlob(repository: Repository, content: Uint8Array): Promise<string> {
    if (content.byteLength > 1024 * 1024) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    const expectedSha = await gitBlobSha(content);
    const result = await this.#request(`${repoApiPath(repository)}/git/blobs`, {
      method: "POST", token: this.#token(repository), body: { content: bytesToBase64(content), encoding: "base64" },
    });
    const sha = stringAt(asRecord(result.data), "sha");
    if (!validGitSha(sha) || sha !== expectedSha) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    return sha;
  }

  async createTree(repository: Repository, baseTreeSha: string, updates: GitTreeUpdate[]): Promise<string> {
    if (!validGitSha(baseTreeSha)) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    const tree = updates.map((update) => {
      if (update.mode !== "100644" || update.type !== "blob" || (update.sha !== null && !validGitSha(update.sha))) {
        throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
      }
      validateGitObjectPath(update.path);
      return { path: update.path, mode: update.mode, type: update.type, sha: update.sha };
    });
    const result = await this.#request(`${repoApiPath(repository)}/git/trees`, {
      method: "POST", token: this.#token(repository), body: { base_tree: baseTreeSha, tree },
      conflictCode: "BASE_TREE_CONFLICT", unprocessableCode: "BASE_TREE_CONFLICT",
    });
    const sha = stringAt(asRecord(result.data), "sha");
    if (!validGitSha(sha)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
    return sha;
  }

  async createCommit(repository: Repository, input: CreateCommitInput): Promise<GitCommit> {
    if (!validGitSha(input.treeSha) || !validGitSha(input.parentSha)) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    const result = await this.#request(`${repoApiPath(repository)}/git/commits`, {
      method: "POST", token: this.#token(repository),
      body: { message: input.message, tree: input.treeSha, parents: [input.parentSha] },
    });
    return parseCreatedGitCommit(result.data, input);
  }

  async createRef(repository: Repository, ref: string, sha: string): Promise<void> {
    if (!validGitSha(sha)) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    const branch = normalizeBranchRef(ref);
    const result = await this.#request(`${repoApiPath(repository)}/git/refs`, {
      method: "POST", token: this.#token(repository),
      body: { ref: `refs/heads/${branch}`, sha },
      conflictCode: "BRANCH_CONFLICT", unprocessableCode: "BRANCH_CONFLICT",
    });
    const record = asRecord(result.data);
    const object = asRecord(record.object);
    if (record.ref !== `refs/heads/${branch}` || object.sha !== sha || object.type !== "commit") {
      throw new PublicationFailure("GITHUB_UNAVAILABLE");
    }
  }

  async listPullRequests(repository: Repository, headRef: string, baseRef: string): Promise<PullRequestRecord[]> {
    this.#requirePullRequestPermission();
    const head = normalizeBranchRef(headRef);
    const base = normalizeBranchRef(baseRef);
    const output: PullRequestRecord[] = [];
    for (let page = 1; page <= MAX_PR_PAGES; page += 1) {
      const query = new URLSearchParams({
        state: "all",
        head: `${repository.owner}:${head}`,
        base,
        per_page: "100",
        page: String(page),
      });
      const result = await this.#request(`${repoApiPath(repository)}/pulls?${query}`, { token: this.#token(repository) });
      if (!Array.isArray(result.data) || result.data.length > 100) throw new PublicationFailure("GITHUB_UNAVAILABLE");
      for (const item of result.data) {
        const pullRequest = parsePullRequest(item);
        if (pullRequest.headRef === head && pullRequest.baseRef === base) output.push(pullRequest);
      }
      if (result.data.length < 100) return output;
    }
    throw new PublicationFailure("GITHUB_UNAVAILABLE");
  }

  async createPullRequest(repository: Repository, input: CreatePullRequestInput): Promise<PullRequestRecord> {
    this.#requirePullRequestPermission();
    const headRef = normalizeBranchRef(input.headRef);
    const baseRef = normalizeBranchRef(input.baseRef);
    const result = await this.#request(`${repoApiPath(repository)}/pulls`, {
      method: "POST", token: this.#token(repository),
      body: { title: input.title, body: input.body, head: headRef, base: baseRef, draft: false },
      conflictCode: "PULL_REQUEST_CONFLICT", unprocessableCode: "PULL_REQUEST_CONFLICT",
    });
    const pullRequest = parsePullRequest(result.data);
    if (pullRequest.headRef !== headRef || pullRequest.baseRef !== baseRef
      || !sameRepository(pullRequest.headRepository, repository) || !sameRepository(pullRequest.baseRepository, repository)) {
      throw new PublicationFailure("PULL_REQUEST_CONFLICT");
    }
    return pullRequest;
  }

  async #readTreeRecursive(
    repository: Repository,
    treeSha: string,
    prefix: string,
    depth: number,
    entryCounter: { count: number },
  ): Promise<GitTreeEntry[]> {
    if (depth > MAX_TREE_DEPTH) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
    const result = await this.#request(`${repoApiPath(repository)}/git/trees/${treeSha}`, {
      token: this.#token(repository), maxBytes: MAX_JSON_RESPONSE_BYTES,
    });
    const entries = parseGitTreePage(result.data, treeSha, prefix, entryCounter);
    const output = [...entries];
    for (const entry of entries) {
      if (entry.type === "tree") {
        output.push(...await this.#readTreeRecursive(repository, entry.sha, entry.path, depth + 1, entryCounter));
      }
    }
    return output;
  }

  async #request(path: string, options: RequestOptions & { allowNotFound: true }): Promise<JsonResponse | undefined>;
  async #request(path: string, options: RequestOptions): Promise<JsonResponse>;
  async #request(path: string, options: RequestOptions): Promise<JsonResponse | undefined> {
    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN || !url.pathname.startsWith("/")) throw new PublicationFailure("INTERNAL_ERROR");
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    let httpStatus: number | undefined;
    let outcome = "request_failed";
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "Kirisame-GitHub-App/1.0",
    });
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json; charset=utf-8");
      body = JSON.stringify(options.body);
    }
    try {
      const response = await fetchGitHubResponse(this.#fetch, url, options, headers, body, controller.signal);
      httpStatus = response.status;
      const processed = await processGitHubResponse(response, options, this.#now, controller.signal);
      outcome = processed.outcome;
      return processed.result;
    } catch (error) {
      if (error instanceof PublicationFailure) outcome = error.code;
      else outcome = "GITHUB_UNAVAILABLE";
      throw error;
    } finally {
      clearTimeout(timeout);
      console.info(JSON.stringify({
        operation: "github_api",
        category: apiOperationCategory(url.pathname),
        method: options.method ?? "GET",
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        outcome,
        durationMs: Date.now() - startedAt,
      }));
    }
  }

  #token(repository: Repository): string {
    if (!this.#installationToken || this.#authorizedRepositoryKey !== repositoryKey(repository)
      || !this.#identity || this.#authorizedOperation === undefined) {
      throw new PublicationFailure("PUBLISHING_UNAVAILABLE");
    }
    if (this.#now() >= this.#tokenExpiresAt) throw new PublicationFailure("GITHUB_AUTH_UNAVAILABLE");
    return this.#installationToken;
  }

  #requirePullRequestPermission(): void {
    if (this.#authorizedOperation !== "pr") throw new PublicationFailure("GITHUB_PERMISSION_DENIED");
  }
}

function parseGitCommit(value: unknown, expectedSha: string): GitCommit {
  const record = asRecord(value);
  const treeSha = stringAt(asRecord(record.tree), "sha");
  const message = record.message;
  const parents = record.parents;
  if (record.sha !== expectedSha || !validGitSha(treeSha) || typeof message !== "string" || message.length === 0
    || !Array.isArray(parents)) throw new PublicationFailure("GITHUB_UNAVAILABLE");

  const parentShas = parents.map((parent) => stringAt(asRecord(parent), "sha"));
  if (parentShas.some((parent) => !validGitSha(parent))) throw new PublicationFailure("GITHUB_UNAVAILABLE");
  return {
    sha: expectedSha,
    treeSha,
    ...(parentShas.length === 1 ? { parentSha: parentShas[0]! } : {}),
    message,
  };
}

async function decodeGitHubBlob(value: unknown, expectedSha: string): Promise<Uint8Array> {
  const record = asRecord(value);
  if (record.sha !== expectedSha) throw new PublicationFailure("GITHUB_UNAVAILABLE");
  const { size, encoding, content } = record;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024
    || encoding !== "base64" || typeof content !== "string") throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  const bytes = decodeGitHubBase64(content);
  if (!bytes || bytes.byteLength !== size || await gitBlobSha(bytes) !== expectedSha) {
    throw new PublicationFailure("GITHUB_UNAVAILABLE");
  }
  return bytes;
}

function parseCreatedGitCommit(value: unknown, input: CreateCommitInput): GitCommit {
  const record = asRecord(value);
  const commitSha = stringAt(record, "sha");
  const treeSha = stringAt(asRecord(record.tree), "sha");
  const message = stringAt(record, "message");
  const parents = record.parents;
  if (!validGitSha(commitSha) || treeSha !== input.treeSha || message !== input.message
    || !Array.isArray(parents) || parents.length !== 1
    || stringAt(asRecord(parents[0]), "sha") !== input.parentSha) {
    throw new PublicationFailure("GITHUB_UNAVAILABLE");
  }
  return { sha: commitSha, treeSha, parentSha: input.parentSha, message };
}

function parseGitTreePage(
  value: unknown,
  treeSha: string,
  prefix: string,
  entryCounter: { count: number },
): GitTreeEntry[] {
  const record = asRecord(value);
  if (record.sha !== treeSha || record.truncated !== false || !Array.isArray(record.tree)) {
    throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  }
  const names = new Set<string>();
  return record.tree.map((item) => parseGitTreeEntry(item, prefix, names, entryCounter));
}

function parseGitTreeEntry(
  item: unknown,
  prefix: string,
  names: Set<string>,
  entryCounter: { count: number },
): GitTreeEntry {
  const raw = asRecord(item);
  const name = stringAt(raw, "path");
  const mode = stringAt(raw, "mode");
  const type = stringAt(raw, "type");
  const sha = stringAt(raw, "sha");
  assertGitTreeEntry(name, mode, type, sha, names);
  names.add(name);
  entryCounter.count += 1;
  if (entryCounter.count > MAX_TREE_ENTRIES) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
  return { path: prefix ? `${prefix}/${name}` : name, mode, type, sha };
}

function assertGitTreeEntry(
  name: string,
  mode: string,
  type: string,
  sha: string,
  names: Set<string>,
): void {
  if (!name || name.includes("/") || name === "." || name === ".." || !validGitSha(sha)
    || !isValidModeType(mode, type) || names.has(name)) throw new PublicationFailure("UNSUPPORTED_GIT_OBJECT");
}

interface ProcessedResponse {
  result: JsonResponse | undefined;
  outcome: "success" | "not_found";
}

async function fetchGitHubResponse(
  fetcher: typeof fetch,
  url: URL,
  options: RequestOptions,
  headers: Headers,
  body: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetcher(url, {
      method: options.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
      // Keep redirects visible for safe status telemetry, but never forward the App
      // JWT or installation token to another host.
      redirect: "manual",
      signal,
    });
  } catch {
    throw new PublicationFailure(signal.aborted ? "GITHUB_TIMEOUT" : "GITHUB_UNAVAILABLE");
  }
}

async function processGitHubResponse(
  response: Response,
  options: RequestOptions,
  now: () => number,
  signal: AbortSignal,
): Promise<ProcessedResponse> {
  if (response.status === 404 && options.allowNotFound) {
    await response.body?.cancel();
    return { result: undefined, outcome: "not_found" };
  }
  if (!response.ok) throw await responseFailure(response, options, now);
  if (response.status === 204) {
    await response.body?.cancel();
    return { result: { data: undefined, headers: response.headers, status: response.status }, outcome: "success" };
  }

  const text = await readSuccessText(response, options.maxBytes ?? MAX_JSON_RESPONSE_BYTES, signal);
  return {
    result: { data: parseJson(text), headers: response.headers, status: response.status },
    outcome: "success",
  };
}

async function responseFailure(response: Response, options: RequestOptions, now: () => number): Promise<PublicationFailure> {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now());
  const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
  const errorMessage = await readResponseText(response, MAX_ERROR_RESPONSE_BYTES).catch(() => "");
  if (response.status === 403 || response.status === 429) return rateLimitFailure(response, retryAfter, rateLimitRemaining, errorMessage, now);
  return failureForHttpStatus(response.status, options);
}

function failureForHttpStatus(status: number, options: RequestOptions): PublicationFailure {
  switch (status) {
    case 401:
      return new PublicationFailure("GITHUB_AUTH_INVALID");
    case 404:
      return new PublicationFailure(options.notFoundCode ?? "GITHUB_UNAVAILABLE");
    case 408:
      return new PublicationFailure("GITHUB_TIMEOUT");
    case 409:
      return new PublicationFailure(options.conflictCode ?? "GITHUB_UNAVAILABLE");
    case 422:
      return new PublicationFailure(options.unprocessableCode ?? "GITHUB_UNAVAILABLE");
    default:
      return new PublicationFailure("GITHUB_UNAVAILABLE");
  }
}

function rateLimitFailure(
  response: Response,
  retryAfter: number | undefined,
  rateLimitRemaining: string | null,
  errorMessage: string,
  now: () => number,
): PublicationFailure {
  if (response.status !== 429 && retryAfter === undefined && rateLimitRemaining !== "0" && !isRateLimitMessage(errorMessage)) {
    return new PublicationFailure("GITHUB_PERMISSION_DENIED");
  }
  return new PublicationFailure("GITHUB_RATE_LIMITED", {
    retryAfterSeconds: retryAfter ?? resetDelay(response.headers.get("x-ratelimit-reset"), now()),
  });
}

async function readSuccessText(response: Response, maximumBytes: number, signal: AbortSignal): Promise<string> {
  try {
    return await readResponseText(response, maximumBytes);
  } catch (error) {
    if (signal.aborted) throw new PublicationFailure("GITHUB_TIMEOUT");
    throw error;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PublicationFailure("GITHUB_UNAVAILABLE");
  }
}

async function readResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new PublicationFailure("GITHUB_UNAVAILABLE");
  }
  if (!response.body) return "";
  const bytes = await readLimitedBytes(response.body, maximumBytes);
  if (!bytes) throw new PublicationFailure("GITHUB_UNAVAILABLE");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PublicationFailure("GITHUB_UNAVAILABLE");
  }
}

function parseInstallation(value: unknown, repository: Repository, expectedAppId: string): {
  id: number;
  permissions: Record<string, string>;
} {
  const record = asRecord(value);
  const id = record.id;
  const appId = record.app_id;
  const account = asRecord(record.account);
  const login = account.login;
  const suspendedAt = record.suspended_at;
  const permissions = asRecord(record.permissions);
  assertInstallationId(id);
  assertInstallationAppId(appId, expectedAppId);
  assertInstallationOwner(login, repository);
  assertInstallationActive(suspendedAt);
  return { id, permissions: stringRecord(permissions) };
}

function assertInstallationId(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new PublicationFailure("APP_NOT_INSTALLED");
  }
}

function assertInstallationAppId(value: unknown, expectedAppId: string): void {
  if (value === undefined || String(value) !== expectedAppId) throw new PublicationFailure("APP_NOT_INSTALLED");
}

function assertInstallationOwner(value: unknown, repository: Repository): void {
  if (typeof value !== "string" || value.toLowerCase() !== repository.owner.toLowerCase()) {
    throw new PublicationFailure("APP_NOT_INSTALLED");
  }
}

function assertInstallationActive(suspendedAt: unknown): void {
  if (suspendedAt !== undefined && suspendedAt !== null) throw new PublicationFailure("APP_NOT_INSTALLED");
}

function assertInstallationPermissions(permissions: Record<string, string>, operation: "branch" | "pr"): void {
  if (permissions.contents !== "write" || (operation === "pr" && permissions.pull_requests !== "write")) {
    throw new PublicationFailure("GITHUB_PERMISSION_DENIED");
  }
  if (permissions.metadata !== undefined && permissions.metadata !== "read") {
    throw new PublicationFailure("GITHUB_PERMISSION_DENIED");
  }
}

function parseInstallationToken(
  value: unknown,
  repository: Repository,
  requestedPermissions: Record<string, string>,
  now: number,
): InstallationTokenResponse {
  const record = asRecord(value);
  const token = record.token;
  const expiresAtString = record.expires_at;
  const expiresAt = typeof expiresAtString === "string" ? Date.parse(expiresAtString) : Number.NaN;
  const permissions = stringRecord(asRecord(record.permissions));
  if (!isValidInstallationToken(token, expiresAt, now)) throw new PublicationFailure("GITHUB_AUTH_INVALID");
  const repositories = parseScopedTokenRepository(record.repositories, repository);
  assertTokenPermissions(permissions, requestedPermissions);
  return { token, expiresAt, permissions, repositories: [repositories] };
}

function isValidInstallationToken(value: unknown, expiresAt: number, now: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && Number.isFinite(expiresAt) && expiresAt > now + 60_000;
}

function parseScopedTokenRepository(value: unknown, repository: Repository): { id: number; fullName: string } {
  if (!Array.isArray(value) || value.length !== 1) throw new PublicationFailure("GITHUB_AUTH_INVALID");
  const record = asRecord(value[0]);
  const id = record.id;
  const fullName = record.full_name;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || typeof fullName !== "string"
    || fullName.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase()) {
    throw new PublicationFailure("GITHUB_AUTH_INVALID");
  }
  return { id, fullName };
}

function assertTokenPermissions(
  permissions: Record<string, string>,
  requestedPermissions: Record<string, string>,
): void {
  if (!hasOnlyRequestedPermissions(permissions, requestedPermissions)
    || !containsRequestedPermissions(permissions, requestedPermissions)) {
    throw new PublicationFailure("GITHUB_PERMISSION_DENIED");
  }
}

function hasOnlyRequestedPermissions(
  permissions: Record<string, string>,
  requestedPermissions: Record<string, string>,
): boolean {
  return Object.entries(permissions).every(([permission, level]) =>
    (permission === "metadata" && level === "read") || requestedPermissions[permission] === level);
}

function containsRequestedPermissions(
  permissions: Record<string, string>,
  requestedPermissions: Record<string, string>,
): boolean {
  return Object.entries(requestedPermissions).every(([permission, level]) => permissions[permission] === level);
}

function parseRepositoryIdentity(value: unknown, expected: Repository, installationId: number): RepositoryIdentity {
  const record = asRecord(value);
  const id = record.id;
  const fullName = record.full_name;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || typeof fullName !== "string"
    || fullName.toLowerCase() !== `${expected.owner}/${expected.name}`.toLowerCase()) {
    throw new PublicationFailure("APP_NOT_INSTALLED");
  }
  return { ...expected, id, fullName, installationId };
}

function parsePullRequest(value: unknown): PullRequestRecord {
  const record = asRecord(value);
  const number = record.number;
  const url = record.html_url;
  const state = record.state;
  const mergedAt = record.merged_at;
  const { headRepository, baseRepository, headRef, baseRef } = parsePullRequestRepositories(record);
  const title = stringAt(record, "title");
  const body = record.body === null ? "" : record.body;
  assertPullRequestNumber(number);
  assertPullRequestUrl(url);
  assertPullRequestState(state, mergedAt);
  if (typeof body !== "string") throw new PublicationFailure("GITHUB_UNAVAILABLE");
  const normalizedState = mergedAt ? "merged" : state;
  return {
    number,
    url,
    state: normalizedState,
    headRef,
    baseRef,
    headRepository,
    baseRepository,
    title,
    body,
  };
}

function parsePullRequestRepositories(record: Record<string, unknown>): {
  headRepository: Repository;
  baseRepository: Repository;
  headRef: string;
  baseRef: string;
} {
  try {
    const head = asRecord(record.head);
    const base = asRecord(record.base);
    return {
      headRepository: parseRepository(asRecord(head.repo)),
      baseRepository: parseRepository(asRecord(base.repo)),
      headRef: stringAt(head, "ref"),
      baseRef: stringAt(base, "ref"),
    };
  } catch {
    throw new PublicationFailure("PULL_REQUEST_CONFLICT");
  }
}

function assertPullRequestNumber(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new PublicationFailure("GITHUB_UNAVAILABLE");
  }
}

function assertPullRequestUrl(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isCanonicalPullRequestUrl(value)) {
    throw new PublicationFailure("GITHUB_UNAVAILABLE");
  }
}

function assertPullRequestState(
  state: unknown,
  mergedAt: unknown,
): asserts state is "open" | "closed" {
  if ((state !== "open" && state !== "closed") || (mergedAt !== null && typeof mergedAt !== "string")) {
    throw new PublicationFailure("GITHUB_UNAVAILABLE");
  }
}

function parseRepository(value: Record<string, unknown>): Repository {
  const fullName = value.full_name;
  if (typeof fullName !== "string") throw new PublicationFailure("GITHUB_UNAVAILABLE");
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts.every((part) => part.length > 0)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
  return { owner: parts[0]!, name: parts[1]! };
}

function repoApiPath(repository: Repository): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function normalizeBranchRef(ref: string): string {
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  if (!branch || branch.startsWith("refs/") || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)*$/u.test(branch)
    || branch.includes("..") || branch.includes("@{") || branch.split("/").some((part) => part.endsWith(".lock"))) {
    throw new PublicationFailure("UNAUTHORIZED_CALLER");
  }
  return branch;
}

function encodeBranchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function isValidModeType(mode: string, type: string): boolean {
  return (mode === "040000" && type === "tree")
    || (["100644", "100755", "120000"].includes(mode) && type === "blob")
    || (mode === "160000" && type === "commit");
}

function apiOperationCategory(pathname: string): string {
  if (pathname.endsWith("/access_tokens")) return "installation_token";
  if (pathname.endsWith("/installation")) return "app_installation";
  if (pathname.endsWith("/git/refs") || pathname.includes("/git/ref/heads/")) return "git_reference";
  if (pathname.includes("/git/commits")) return "git_commit";
  if (pathname.includes("/git/trees")) return "git_tree";
  if (pathname.includes("/git/blobs")) return "git_blob";
  if (pathname.endsWith("/pulls")) return "pull_request";
  return "repository_metadata";
}

function sameRepository(left: Repository, right: Repository): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.name.toLowerCase() === right.name.toLowerCase();
}

function isCanonicalPullRequestUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function decodeGitHubBase64(value: string): Uint8Array | undefined {
  const compact = value.replace(/\s+/gu, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact)) return undefined;
  try {
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytesToBase64(bytes) === compact ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400, Math.ceil(seconds));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(86_400, Math.max(0, Math.ceil((date - now) / 1000)));
}

function resetDelay(value: string | null, now: number): number {
  if (!value || !/^\d+$/.test(value)) return 60;
  return Math.min(86_400, Math.max(1, Number(value) - Math.floor(now / 1000)));
}

function isRateLimitMessage(text: string): boolean {
  try {
    const value = asRecord(JSON.parse(text));
    return typeof value.message === "string" && /rate limit/iu.test(value.message);
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PublicationFailure("GITHUB_UNAVAILABLE");
  return value as Record<string, unknown>;
}

function stringAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, level] of Object.entries(value)) {
    if (typeof level !== "string") throw new PublicationFailure("GITHUB_UNAVAILABLE");
    result[key] = level;
  }
  return result;
}
