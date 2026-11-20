# Phase 1 plan

Phase 1 establishes a mock-driven Cloudflare Worker foundation. It does not integrate real GitHub credentials, create GitHub branches or pull requests, provision a production binding, or add storage resources.

## Bounded implementation

1. **Project structure:** strict TypeScript Worker source with modules for request routing, contract validation, policy, GitHub adapter interface and safe errors. Keep JSON Schema v1 canonical and test the checked-in schemas and fixtures as data.
2. **Worker runtime:** Wrangler configuration for local development and Cloudflare Workers Vitest. Do not configure a production Service Binding, GitHub secret, R2 bucket, D1 database, Queue, KV, Durable Object or Workflow.
3. **Private service contract:** implement POST /internal/v1/publications for Service Binding calls only in the local/test environment. Test it with a stub binding; do not add a public route or production target.
4. **Runtime validation:** enforce content type, a 9 MiB request body cap before JSON parsing, v1-only validation, strict unknown-field rejection, artifact provenance and digest checks, path checks, request fingerprint and safe failure classification.
5. **Mock GitHub adapter:** define narrow operations for reading installation/repository/base state, reading tree paths, creating blobs/tree/commit/ref, listing PRs and creating a PR. The mock records operations and injects conflicts, timeouts and rate-limit responses. No real adapter or token generation is included.
6. **Diagnostics:** minimal health endpoint returns service and contract version. Health must not disclose secrets, installation inventory, allowlists, raw errors or artifact data.
7. **Compatibility tests:** run positive and negative contract fixtures through the Worker handler, assert version and unknown-field rejection, and simulate repeated requests and ambiguous mutation outcomes against the mock.
8. **Quality gates:** locked dependency install, contract tests, Worker runtime tests, type check, lint if selected, and Wrangler dry-run in CI. No test should require network access, GitHub or Cloudflare credentials, a deployed service, Docker or a live repository.

## Suggested source layout

~~~text
src/
  index.ts
  routes/publications.ts
  contracts/validate.ts
  publication/policy.ts
  publication/reconcile.ts
  github/GitHubAdapter.ts
  github/MockGitHubAdapter.ts
  errors/publication-error.ts
tests/
  worker/
  contracts/
contracts/v1/
~~~

The file-change and result contracts remain language-neutral. TypeScript may generate or validate types at build time, but Rust clients consume the JSON Schemas and fixture files without depending on a shared runtime package.

## Cross-repository prerequisites before publishing can be enabled

Soyuz work is required before a Kirisame mock can be replaced by a real GitHub adapter:

- Add a publication record keyed by unique publicationId, with an immutable fingerprint, canonical runId, requested mode, exact repository/baseRef/baseSha, artifact ID/digest, transition state, attempt lease/fence, next-attempt timestamp and terminal result.
- Add D1 compare-and-set dispatch serialization and append-only publication events. Keep execution statuses and callbacks unchanged until a separately reviewed migration.
- Define how trusted validation evidence is recorded and checked before publication. Do not authorize from a worker-supplied boolean alone.
- Resolve publishMode auto and none in Soyuz and call Kirisame only with branch or pr.
- Resolve the actual publication base branch and exact base commit. The existing run ref is not enough to assume both values or pin the checkout commit.
- Have executors produce the v1 file-change manifest and bind it to the canonical run and current claim fence. Current Soyuz artifact uploads are generic diagnostic files.
- Extend artifact retention so a manifest survives run-history culling while publication remains pending, publishing, retryable or blocked.
- Add a private Soyuz-to-Kirisame Service Binding, request timeout, retry scheduler, rollout order and independent version compatibility tests.
- Migrate Kaseki publication out of the execution worker only after a canary proves artifacts, authorization, PR reconciliation and recovery. Remove GitHub write credentials from coding hosts after cutover.
- Implement the same artifact production contract for Rusty-Fossil when its executor exists; its current repository has no coding or publishing capability.

## Later phase boundary

GitHub App JWT signing, installation token minting, allowlist configuration, real GitHub API calls, repository policy rollout, production Service Bindings, storage bindings and operational deployment belong after the Phase 1 mock foundation. GitHub publication should remain disabled until the Soyuz prerequisites above are implemented and cross-repository rollout is approved.
