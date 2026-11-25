# Operations

## Current production state

The current production deployment is version `81e0b8a2-6cb3-41aa-b6cf-94b00b0da4cf` (deployment `5fc350d2-3f7e-437f-b242-0a95ec398e32`, source `3f850ed1a3a3da1b7dd2f014dc1b73ff22f3c843`, 100% traffic). It has `PUBLISHING_ENABLED=true` and a single allowlist entry for `CyanAutomation/somatic`, PR operations, and base branch `main`. Cloudflare confirmed the existing `GITHUB_APP_PRIVATE_KEY` remains a `secret_text` binding; the value was neither read nor changed during this deployment. The GitHub App is installed on `CyanAutomation/somatic` with all-repositories access. Its current grants are Metadata read, Actions read, Checks read/write, Contents read/write, Commit statuses read/write, and Pull requests read/write; the App owner accepts this installation scope and permission set for commissioning. There is no storage or Soyuz Service Binding. The public publication route remains unavailable over HTTP; the publisher is callable only through its private entrypoint. Observability is enabled with persisted logs sampled at 20% and traces at 5%. See the live canary record below.

The prior diagnostics-only deployment was created on 2026-11-21. The Cloudflare account subdomain is `scheimann`; the safe 2026-11-22 upload updated the existing `kirisame` Worker.

The root diagnostics response includes a sanitized `version` object with source commit, application version, contract version and build timestamp. CI sets the source from `GITHUB_SHA` and the timestamp before build/typecheck. Local builds use safe fallback values. Invalid or absent metadata becomes `unknown`; `/` and `/health` remain live and never expose binding values or secrets.

The intended Worker is `kirisame` at `https://kirisame.scheimann.workers.dev/`, in Cloudflare account `c40f3cb30efbf8c6d081cf9e50a61931`. `cloudflare.config.ts` is the project configuration. The repository uses Cloudflare's `cf` CLI and Cloudflare Vite plugin; it does not maintain Wrangler configuration. Cloudflare CLI `cf` and its configuration are in release-candidate status, so keep the lockfile committed and review CLI/plugin upgrades.

## Local development and checks

Use a Node.js version supported by the Cloudflare `cf` CLI (Node 22.23.0 or newer in the 22 line), then run:

```sh
npm ci
npm run dev
```

The local development server runs the Worker through the Cloudflare Vite plugin. Run the full CI checks with:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm audit
```

`npm test` runs the contract, Workers runtime, authentication, HTTP adapter and simulated publication suites. Tests use ephemeral signing keys and mocked GitHub HTTP responses; they do not need Cloudflare credentials, a real GitHub key or access to a live repository.

## Deployment preflight and deployment

Deploy only after all checks above pass. Before an initial deployment, verify all of the following in the intended account:

1. The account ID matches `c40f3cb30efbf8c6d081cf9e50a61931`.
2. The account's `workers.dev` subdomain is `scheimann`.
3. A Worker named `kirisame` does not exist, or its current deployment and ownership have been reviewed and it is safe to replace.
4. `PUBLISHING_ENABLED` is `false`, `GITHUB_REPOSITORY_ALLOWLIST` is `[]`, and no GitHub App private key value is bundled.
5. The deployment has no Soyuz Service Binding or repository data binding. The mock publisher exists only in `tests/worker/test-entrypoint.ts`.

Build and deploy with:

```sh
npm run build
npm run deploy
```

`npm run deploy` invokes `cf deploy`. Authenticate with `cf auth login` or a scoped `CLOUDFLARE_API_TOKEN`; do not put credentials in source control. Review the `cf deploy` target account and Worker name before deploying. Deployment is intentionally manual; CI never deploys. The 2026-11-22 safe deployment used the connected Cloudflare API after the local CLI could not authenticate; no credential was added to the workspace.

After deployment, check the public responses:

```sh
curl -i https://kirisame.scheimann.workers.dev/
curl -i https://kirisame.scheimann.workers.dev/health
curl -i https://kirisame.scheimann.workers.dev/readyz
curl -i https://kirisame.scheimann.workers.dev/internal/v1/publications
```

With the checked-in default configuration, `/` returns service identity and `publishing: unavailable`; `/health` returns `200` and `status: ok`; `/readyz` returns `503` and `status: not_ready`; the private HTTP path returns `404`. Unsupported methods on the diagnostic routes return `405`. Headers such as `Authorization` or `x-soyuz-service` never grant publishing access. Readiness checks configuration only and never issue a GitHub token or request.

The private `PublisherEntrypoint.publish(requestJson)` method is a typed RPC surface. It is not an HTTP route and is not callable through the `workers.dev` URL. The private commissioning invoker has a `KIRISAME` Service Binding to this entrypoint; no Soyuz-to-Kirisame binding is configured. For a future Phase 2C integration, configure `KIRISAME` only in Soyuz after its durable publication controls are ready.

## Private live-canary invocation

The `canary-harness` mode is a local-only caller for the existing production Worker. Its `KIRISAME` Service Binding targets the `PublisherEntrypoint` export on `kirisame` with remote development enabled; it does not call a public publishing URL and does not receive GitHub credentials. Its only enabled target is `CyanAutomation/somatic` with base `main`, and it accepts PR mode only. Cloudflare's remote Worker Service Binding support is required. Do not deploy the `kirisame-canary-harness` entrypoint.

The harness route rejects non-loopback hosts, accepts only PR requests for the configured repository and base branch with the deterministic `kirisame/p/{publicationId}` head, and replays the exact original JSON only after an open PR is confirmed. Run it with `npm run dev -- --mode canary-harness`. The Worker's exact allowlist and publishing flag must be set through Cloudflare only after a successful authorization preflight. For this commissioning, keep `PUBLISHING_ENABLED=true` with only the `CyanAutomation/somatic` PR-to-`main` allowlist entry, as requested by the App owner. Do not add other repositories or operations. Do not use the `canary-receiver` mode for this procedure or configure a Soyuz binding.

For the current commissioning, use the deployed private Workflow invoker `kirisame-live-invoker`: invoke `preflight` and require the exact verified Somatic result, then use `allowlist-probe` and require `confirmed-denial`, then invoke `publish` with the approved Somatic PR request. Its `publish` action replays the byte-identical request only after an open matching PR is confirmed. The invoker has no workers.dev or preview URL, no triggers, and only a `KIRISAME` binding to `kirisame.PublisherEntrypoint`; it does not expose a public publishing route. Keep the production gate enabled with the exact Somatic PR-to-`main` allowlist after the canary and verify both through Cloudflare.

For the 2026-11-23 commissioning attempt, the local harness was not used. A deployed private Workflow invoker, `kirisame-live-invoker`, called the existing `kirisame.PublisherEntrypoint` over a Service Binding. Its workers.dev and preview URLs were disabled, it had no triggers, and its only binding was `KIRISAME` to `kirisame`/`PublisherEntrypoint`. The public invoker fetch handler returns 404. This used the production `kirisame` publisher; it did not use `kirisame-canary`.

### Phase 2A.2 commissioning record — 2026-11-23

The approved test was attempted through deployed Cloudflare resources. Production `kirisame` stayed on version 9 (`c97af8cb-3fff-4ae2-919d-dfebcbdb9b54`; deployment `fc5f7188-d6b3-4aa5-8702-8e305d5d7571`; source `97b74630f3f182d627019ca861ee5de49d43c5da`). The private invoker ran version 10 (`4493ca4f-85af-4141-878c-1eba77549b12`; deployment `4bda6041-98cf-4140-9ef0-ebe466e1e75e`; source `fdbec8d744de85d3111272b35f4584c66d7a32a3`) with Workflow version `71270640-fd8f-4061-9a4b-7fe281834258`. Its Service Binding target was exactly `kirisame.PublisherEntrypoint`.

The read-only authorization preflight completed through the private binding but returned `PUBLISHING_UNAVAILABLE` (Workflow instance `cf_524b03bdba19cc60303e0865d17563b27fc5b96d2a563d66c0e483e45e42b5eb`). The secret binding exists and was left untouched, but this result did not verify GitHub App authentication, installation permissions or the repository-scoped token. Publishing was never enabled and the allowlist was never changed. A separate private publish-path check with the exact approved Somatic fixture returned `PUBLISHING_UNAVAILABLE` (instance `cf_537490518983c4cc1e94f7a54164221d42f3a41890d717bb8b1630f6942121b0`, one completed step); no replay was attempted.

The follow-up preflight result includes a safe `failureStage` alongside the stable publication `code`. It never returns exception messages, App JWTs, installation tokens or key material. Interpret the stage as follows:

| `failureStage` | Meaning and next check |
| --- | --- |
| `configuration` | The App ID or private-key binding is missing or the non-secret configuration is invalid. Check the binding names and App ID in Cloudflare. |
| `private_key_pem_envelope` | The PEM header/footer is missing, mismatched, or has extra surrounding content. Verify the full, unencrypted `RSA PRIVATE KEY` or `PRIVATE KEY` envelope without sharing it. |
| `private_key_pem_base64` | The PEM envelope is recognized, but its body is empty or not canonical base64. Verify the complete body was copied without redaction or literal ellipses. |
| `private_key_crypto_import` | The PEM body decoded, but Web Crypto rejected the DER key. Verify that it is an unencrypted RSA PKCS#1 or PKCS#8 private key. |
| `private_key_import` | Legacy result from deployments before the finer PEM/import diagnosis; it combined the three checks above. |
| `github_app_signing` | The imported key could not sign an App JWT. Do not enable publishing; investigate the configured key/runtime compatibility without exposing the key. |
| `installation_and_token_scope` | GitHub installation, permission, API, or scoped-token validation failed. Use the stable `code` to distinguish missing installation, denied permissions, rejected authentication, rate limiting, or an unavailable response. The adapter requests only `CyanAutomation/somatic` with contents and pull-request write permissions and validates that exact scope before returning success. |
| `internal` | An unexpected preflight failure occurred outside the named checks. Keep publishing disabled and inspect sanitized runtime diagnostics. |

For failures at `installation_and_token_scope`, the private preflight also returns a sanitized `diagnostic.step` and, when GitHub returned a response, its numeric `diagnostic.httpStatus`. Steps distinguish installation lookup and validation, token creation and validation, and repository verification. This helps separate an App-authentication rejection (for example, HTTP 401 during installation lookup) from a malformed or incorrectly scoped installation-token response. The diagnostic never includes request headers, credentials, or response bodies. Transport failures have no HTTP status.

Only `{ status: "verified", repository: "CyanAutomation/somatic" }` is positive authorization evidence. Any rejected result is a stop condition; do not enable the gate or change the allowlist.

GitHub independently shows no `kirisame/p/01a20a97-3e74-7e45-88fb-f29ec304a6e2` branch or matching PR, and `kirisame-canary/verification.txt` is absent from Somatic `main`. No branch, commit or PR was created. The production gate remains `PUBLISHING_ENABLED=false`, the allowlist remains `[]`, the existing private-key secret binding remains present, and there is no Soyuz binding. Public checks returned `/health` 200, `/readyz` 503 with `publishing: unavailable`, and both GET and forged-header POST to `/internal/v1/publications` 404.

The repository checks passed: `npm ci`, `npm test` (44 contract and 207 Worker tests), `npm run typecheck`, `npm run lint`, live-invoker build, and `npm audit` (zero vulnerabilities). `fallow audit` returned `warn` for introduced test/config complexity and a documented private-entrypoint suppression; it reported zero dead-code issues and did not fail the gate. The safe failure result is documented in Kirisame PR #7. Retry only after the generic `PUBLISHING_UNAVAILABLE` result has been resolved and a positive read-only preflight verifies the exact Somatic installation permissions and token scope. Do not enable publishing until then.

### Staged preflight follow-up — 2026-11-24

The staged authorization diagnostic was added in commit `d3aecbc96731786b44f6f9300467e7b323428ea7` and deployed to the existing production `kirisame` Worker as version `0293cc9e-3ba7-4524-ad1e-52c8cbace2a9`, deployment `ff21a4f4-5f93-4dad-b045-48198e9fcea2` (100% traffic). Cloudflare confirmed `KIRISAME_SOURCE_SHA` matches the commit, `GITHUB_APP_PRIVATE_KEY` remains a `secret_text` binding, `PUBLISHING_ENABLED=false`, and `GITHUB_REPOSITORY_ALLOWLIST=[]`. The secret value was neither read nor replaced.

The deployed private invoker's authorization preflight returned `{ status: "rejected", code: "PUBLISHING_UNAVAILABLE", failureStage: "private_key_import" }` (Workflow instance `cf_7987b65adc9d7fbf8fc5bc2ba754219a10e62e8bbea6dbae43ce6c0c954eb049`). Configuration validation passed, but the Worker could not parse/import the bound key. This does not verify GitHub installation permissions or token scope. No publication or replay was attempted, and no Somatic branch, commit or PR was created.

After that deployment, `/health` returned `200`, `/readyz` returned `503` with publishing unavailable, and both GET and a forged-header POST to `/internal/v1/publications` returned `404`. The safe flags, secret binding, and absence of a Soyuz binding were verified again. At that point the key format had not yet been confirmed. The key owner subsequently confirmed the existing unencrypted RSA PKCS#1 PEM format; see the follow-up below. Do not expose, regenerate, or rotate the key.

Follow-up validation passed: `npm ci`, `npm test` (44 contract and 212 Worker tests), `npm run typecheck`, `npm run lint`, `npm run build`, and `npm audit` (zero vulnerabilities). Fallow architecture reported zero issues; `fallow audit` remained advisory `warn` with zero dead-code issues and two moderate complexity findings in the overall PR diff.

### PEM import and GitHub transport follow-up — 2026-11-24

The key owner confirmed that Cloudflare holds the existing App key in an unencrypted RSA PKCS#1 PEM envelope. The safe preflight now distinguishes PEM-envelope, base64-body, and Web Crypto import failures. A one-line PEM with whitespace around or within the encoded body is covered by the Worker tests. The secret value was not read or changed.

This diagnostic was deployed to the production `kirisame` Worker as version `0db1baff-315f-47d8-9d48-f0bf075ba4a9`, deployment `f6aaa2fd-57b3-474a-a9ca-4fccc3703771`, with 100% traffic and source `21b79030d123d0e6aabccb60f6bb1eb8bcc8c9e9`. Cloudflare confirmed that `GITHUB_APP_PRIVATE_KEY` remains a `secret_text` binding, `PUBLISHING_ENABLED=false`, `GITHUB_REPOSITORY_ALLOWLIST=[]`, and no Service Binding on the publisher. The private invoker still binds only to `kirisame.PublisherEntrypoint`; no Soyuz binding was added.

The first two private read-only preflights (`cf_fca310711e996f03f5e6bad87d14a2f3daf9752e97876681fdf5038a0c1558cc` and `cf_dda49a9ee3ecc59cd1db46b5ef97a81e7880d107e61c2e359f9af697d196d51f`) imported the key and signed the App JWT, then returned `GITHUB_UNAVAILABLE` at `installation_and_token_scope`. The cause was `redirect: "error"`: Cloudflare Workers does not implement that mode and throws a `TypeError` before sending the request. The adapter now uses the supported `manual` mode, which exposes a 3xx response without following it or forwarding credentials ([Cloudflare Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)).

The corrected source was deployed to production `kirisame` as version `5c321e52-31c3-43fc-89c2-7accf14bad26`, deployment `dc076461-6244-4b7e-a646-2cf6ba185725`, with 100% traffic and source `deb59bca50aadd1c080995660c6a61c7f368c04c`. Cloudflare verified the existing secret binding, `PUBLISHING_ENABLED=false`, `GITHUB_REPOSITORY_ALLOWLIST=[]`, zero publisher Service Bindings, and enabled observability before deployment.

Two read-only preflights on the corrected version (`cf_55ed112b913622c4e73ad05eceed6332557e8dd594015839dc32436157151441` and `cf_149b5b5e3b563ca6c5934fd94c149d08ef846279e71570ba1f0476ab66a70f87`) returned `{ status: "rejected", code: "GITHUB_AUTH_INVALID", failureStage: "installation_and_token_scope" }`. This code means GitHub returned HTTP 401 or the installation-token response failed Kirisame's validity or exact-scope checks. The sampled logs did not capture a new API category, so those cases cannot be distinguished. The App installation, required permissions, and Somatic-scoped token remain unverified. No GitHub mutation was attempted.

Post-deployment checks on the corrected version returned `/health` 200, `/readyz` 503 with publishing unavailable, and both GET and forged-header POST to `/internal/v1/publications` 404. Keep the publishing gate closed and resolve the `GITHUB_AUTH_INVALID` result before another authorization attempt or any canary mutation. The corrected source passed `npm test` (44 contract and 213 Worker tests), `npm run lint`, `npm run typecheck` (including the production build), and `npm audit` (zero vulnerabilities); CI run [45408450399](https://github.com/CyanAutomation/kirisame/actions/runs/45408450399) passed.

### App owner settings acceptance — 2026-11-24

The App owner confirmed that the current GitHub configuration is acceptable for the Phase 2A.2 canary: the installation selects all repositories, and the App grants Metadata read, Actions read, Checks read/write, Contents read/write, Commit statuses read/write, and Pull requests read/write. No installation-scope or permission reduction is required. These grants do not replace Kirisame's exact allowlist or the runtime's exact single-repository, operation-specific token validation.

The owner-reviewed GitHub settings and production Cloudflare bindings do not by themselves resolve the authorization failure. Private preflight Workflow instance `codex-preflight-1795532662040` completed with `{ status: "rejected", code: "GITHUB_AUTH_INVALID", failureStage: "installation_and_token_scope" }`. No GitHub write was attempted. The production flags remain `PUBLISHING_ENABLED=false` and `GITHUB_REPOSITORY_ALLOWLIST=[]`, and the private-key secret was not read or changed. The canary remains gated on a positive read-only preflight; a rejected result is not authorization to enable publishing.

After the App owner accepted the current installation scope and grants, a fresh read-only preflight (`codex-owner-preflight-1795534019508`) returned the same `GITHUB_AUTH_INVALID` at `installation_and_token_scope`. No matching sanitized GitHub API log was captured for that invocation, so the failing API response cannot be distinguished from a malformed/invalid token response. The production flags and secret binding were left unchanged. No canary publication or replay was attempted.

The App owner still needs to verify that the existing Cloudflare secret corresponds to an active private key for App ID `3345400`. Keep the value in Cloudflare and do not share it. Do not enable publishing or repeat the canary until this is verified and a read-only preflight returns the exact verified Somatic result.

## PR replay identity

Repository owner and name comparisons are case-insensitive: Kirisame normalizes both to lowercase for allowlist authorization, GitHub installation identity checks and PR reconciliation. The lowercase `cyanautomation` owner in the preserved canary request is equivalent to `CyanAutomation` and remains unchanged to preserve the original request.

### Live canary commissioning — 2026-11-24

After the owner replaced the GitHub App private key in Cloudflare, private preflight `codex-key-rotation-preflight-20261124` verified the exact `CyanAutomation/somatic` repository and token scope. The public publication route returned 404 for both GET and a forged-header POST. The private `codex-canary-denial-20261124` probe confirmed `REPOSITORY_NOT_ALLOWED` for a non-allowlisted target. Production publishing was then enabled with only the Somatic PR-to-`main` allowlist entry.

The first live Workflow instance, `codex-somatic-canary-20261124`, attempted preserved publication ID `01a20f00-0170-7e6b-8e7b-5f75014f9cdd` against base `0d02873b71256892b4ec8026a3b0e2a5ab6aaa91`. It returned `GITHUB_UNAVAILABLE` with `reconciliation: unknown`; no replay was attempted. Full log sampling showed 50 successful GitHub subrequests while reading nested trees, followed by a failed tree request. This matches the [Workers 50-subrequest ceiling](https://developers.cloudflare.com/workers/platform/limits/) for the bundled usage model; the account's usage model was not independently confirmed. GitHub had no matching branch or PR before retry. The original request and publication identity were retained unchanged.

PR [#11](https://github.com/CyanAutomation/kirisame/pull/11) replaces per-directory tree reads with a single recursive Git Trees response for each tree read, with response-size, entry-count, depth, and truncation checks. It also adds sanitized request/publication IDs to GitHub API events. Source `3f850ed1a3a3da1b7dd2f014dc1b73ff22f3c843` was deployed as Worker version `81e0b8a2-6cb3-41aa-b6cf-94b00b0da4cf` (deployment `5fc350d2-3f7e-437f-b242-0a95ec398e32`). Cloudflare confirmed 100% traffic on that version and preserved the existing private-key secret binding.

The private preflight `codex-tree-fix-preflight-20261124` again verified Somatic authorization. The successful live Workflow instance `codex-somatic-canary-tree-fix-20261124` published the unchanged request as [Somatic PR #128](https://github.com/CyanAutomation/somatic/pull/128), using branch `kirisame/p/01a20f00-0170-7e6b-8e7b-5f75014f9cdd` and commit `5008e55773e67ef83d79fa2df6c16fe5193c88bd`. The outcome was `pr_published` with `pull_request_confirmed`. A byte-identical replay returned the same branch, commit, and open PR with `reused: true`; it did not create a duplicate PR.

Sampled Worker events matched both invocations by publication ID. The original successful publish made 9 GitHub API calls and the idempotent replay made 20. Both ended in `pr_published`; the replay's 404 was a branch-not-found reconciliation lookup, not a failed publication. Neither invocation exhausted the subrequest budget. Full log sampling was returned to the prior 20% rate; persisted logs remain enabled. Publishing remains enabled for the single Somatic PR-to-`main` allowlist entry, as requested. Production Soyuz has not received its binding yet; Soyuz source now declares the private entrypoint and exact allowlist with dispatch disabled.

GitHub PR identity is confirmed from the canonical repository, head/base refs, open state, canonical URL and the exact marker binding publication ID, run ID, artifact digest and complete request digest. Maintainers can edit the PR title and descriptive text while preserving that marker exactly once. Kirisame does not overwrite those edits. A missing, duplicated, changed or different-request marker, a repository/ref mismatch, or a closed/merged PR remains a conflict.

If a future HTTP facade is explicitly approved, map contract outcomes to transport statuses consistently: invalid input `400`, policy denial `403`, conflict `409`, `GITHUB_RATE_LIMITED` `429` with `Retry-After`, other retryable failures `503`, `PUBLISHING_UNAVAILABLE` `501`, and internal failures `500`. Keep the structured v1 body unchanged. This mapping does not apply to typed RPC responses.

## Observability and safe diagnostics

Workers Observability logs and traces are enabled in the Worker configuration with sampling. Runtime logs contain only the operation name, generated request ID, publication/run IDs, mode, outcome, retryability, reconciliation result, safe GitHub API category/status and duration. API category logs do not include owner/repository paths. Never add repository content, artifact bytes, authorization headers, GitHub response bodies, private keys, tokens or stack traces to logs. Investigate through the Cloudflare dashboard's Worker logs and traces; keep repository and request identifiers out of metric labels.

## Rollback

Use the Cloudflare dashboard: **Workers & Pages → kirisame → Deployments**, select the last known-good version and choose **Rollback**. Before rollback, record the version's `sourceCommit` from `/` so the Cloudflare deployment can be tied to its GitHub revision. After rollback, confirm the public version metadata reports the intended source commit, repeat the public diagnostics checks above, and confirm `/readyz` reflects the intended publishing state. No external binding or data resource is configured in this phase, so there is no publication state to migrate. See Cloudflare's [Worker rollback guidance](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Production publishing prerequisites

The GitHub App adapter, reconciliation, and Somatic live canary are complete; see the commissioning record above. Production publishing remains enabled only for Somatic PRs against `main`. Soyuz's durable ledger and migration `0009` are already deployed. Kaseki source implements the trusted claim-bound manifest/evidence producer, but its execution host still needs rollout. Soyuz source declares the private `KIRISAME` binding, exact Somatic PR-to-`main` allowlist, and dispatch disabled; production has not received that configuration. Verify host preflight, the persisted per-run legacy-versus-Kirisame route, identical replay, and retention on a new canonical run before enabling Soyuz dispatch in a separately reviewed change. Never use the public Worker URL as Soyuz's integration endpoint. See [GitHub App setup](GITHUB-APP.md).
