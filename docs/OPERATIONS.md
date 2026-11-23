# Operations

## Current production state

The initial safe GitHub App adapter build was deployed to `https://kirisame.scheimann.workers.dev/` on 2026-11-22 (Cloudflare deployment ID `1e83c0cb-3088-4ab0-9ff8-d90076507133`). The current production deployment is version 9 (`c97af8cb-3fff-4ae2-919d-dfebcbdb9b54`, deployment `fc5f7188-d6b3-4aa5-8702-8e305d5d7571`, source `97b74630f3f182d627019ca861ee5de49d43c5da`). It has `PUBLISHING_ENABLED=false`, `GITHUB_REPOSITORY_ALLOWLIST=[]`, App ID `3345400`, and the existing `GITHUB_APP_PRIVATE_KEY` secret binding. The key value has not been read or changed. There is no storage or Soyuz Service Binding. On 2026-11-23, `/health` returned `200`, `/readyz` returned `503` with publishing unavailable, and both GET and a forged-header POST to `/internal/v1/publications` returned `404`. A private publish-path check returned `PUBLISHING_UNAVAILABLE` while the gate was off.

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

The harness route rejects non-loopback hosts, accepts only PR requests for the configured repository and base branch with the deterministic `kirisame/p/{publicationId}` head, and replays the exact original JSON only after an open PR is confirmed. Run it with `npm run dev -- --mode canary-harness`. The Worker's exact allowlist and publishing flag must be set through Cloudflare only after a successful authorization preflight; restore `PUBLISHING_ENABLED=false` and `GITHUB_REPOSITORY_ALLOWLIST=[]` immediately afterward. Do not use the `canary-receiver` mode for this procedure or configure a Soyuz binding.

For the 2026-11-23 commissioning attempt, the local harness was not used. A deployed private Workflow invoker, `kirisame-live-invoker`, called the existing `kirisame.PublisherEntrypoint` over a Service Binding. Its workers.dev and preview URLs were disabled, it had no triggers, and its only binding was `KIRISAME` to `kirisame`/`PublisherEntrypoint`. The public invoker fetch handler returns 404. This used the production `kirisame` publisher; it did not use `kirisame-canary`.

### Phase 2A.2 commissioning record — 2026-11-23

The approved test was attempted through deployed Cloudflare resources. Production `kirisame` stayed on version 9 (`c97af8cb-3fff-4ae2-919d-dfebcbdb9b54`; deployment `fc5f7188-d6b3-4aa5-8702-8e305d5d7571`; source `97b74630f3f182d627019ca861ee5de49d43c5da`). The private invoker ran version 10 (`4493ca4f-85af-4141-878c-1eba77549b12`; deployment `4bda6041-98cf-4140-9ef0-ebe466e1e75e`; source `fdbec8d744de85d3111272b35f4584c66d7a32a3`) with Workflow version `71270640-fd8f-4061-9a4b-7fe281834258`. Its Service Binding target was exactly `kirisame.PublisherEntrypoint`.

The read-only authorization preflight completed through the private binding but returned `PUBLISHING_UNAVAILABLE` (Workflow instance `cf_524b03bdba19cc60303e0865d17563b27fc5b96d2a563d66c0e483e45e42b5eb`). The secret binding exists and was left untouched, but this result did not verify GitHub App authentication, installation permissions or the repository-scoped token. Publishing was never enabled and the allowlist was never changed. A separate private publish-path check with the exact approved Somatic fixture returned `PUBLISHING_UNAVAILABLE` (instance `cf_537490518983c4cc1e94f7a54164221d42f3a41890d717bb8b1630f6942121b0`, one completed step); no replay was attempted.

GitHub independently shows no `kirisame/p/01a20a97-3e74-7e45-88fb-f29ec304a6e2` branch or matching PR, and `kirisame-canary/verification.txt` is absent from Somatic `main`. No branch, commit or PR was created. The production gate remains `PUBLISHING_ENABLED=false`, the allowlist remains `[]`, the existing private-key secret binding remains present, and there is no Soyuz binding. Public checks returned `/health` 200, `/readyz` 503 with `publishing: unavailable`, and both GET and forged-header POST to `/internal/v1/publications` 404.

The repository checks passed: `npm ci`, `npm test` (44 contract and 207 Worker tests), `npm run typecheck`, `npm run lint`, live-invoker build, and `npm audit` (zero vulnerabilities). `fallow audit` returned `warn` for introduced test/config complexity and a documented private-entrypoint suppression; it reported zero dead-code issues and did not fail the gate. The safe failure result is documented in Kirisame PR #7. Retry only after the generic `PUBLISHING_UNAVAILABLE` result has been resolved and a positive read-only preflight verifies the exact Somatic installation permissions and token scope. Do not enable publishing until then.

## PR replay identity

GitHub PR identity is confirmed from the canonical repository, head/base refs, open state, canonical URL and the exact marker binding publication ID, run ID, artifact digest and complete request digest. Maintainers can edit the PR title and descriptive text while preserving that marker exactly once. Kirisame does not overwrite those edits. A missing, duplicated, changed or different-request marker, a repository/ref mismatch, or a closed/merged PR remains a conflict.

If a future HTTP facade is explicitly approved, map contract outcomes to transport statuses consistently: invalid input `400`, policy denial `403`, conflict `409`, `GITHUB_RATE_LIMITED` `429` with `Retry-After`, other retryable failures `503`, `PUBLISHING_UNAVAILABLE` `501`, and internal failures `500`. Keep the structured v1 body unchanged. This mapping does not apply to typed RPC responses.

## Observability and safe diagnostics

Workers Observability logs and traces are enabled in the Worker configuration with sampling. Runtime logs contain only the operation name, generated request ID, publication/run IDs, mode, outcome, retryability, reconciliation result, safe GitHub API category/status and duration. API category logs do not include owner/repository paths. Never add repository content, artifact bytes, authorization headers, GitHub response bodies, private keys, tokens or stack traces to logs. Investigate through the Cloudflare dashboard's Worker logs and traces; keep repository and request identifiers out of metric labels.

## Rollback

Use the Cloudflare dashboard: **Workers & Pages → kirisame → Deployments**, select the last known-good version and choose **Rollback**. Before rollback, record the version's `sourceCommit` from `/` so the Cloudflare deployment can be tied to its GitHub revision. After rollback, confirm the public version metadata reports the intended source commit, repeat the public diagnostics checks above, and confirm `/readyz` still reports publishing unavailable. No external binding or data resource is configured in this phase, so there is no publication state to migrate. See Cloudflare's [Worker rollback guidance](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Production publishing prerequisites

The GitHub App adapter and reconciliation are implemented. The Phase 2A.2 live canary was authorized but did not publish because the private authorization preflight returned `PUBLISHING_UNAVAILABLE`; see the commissioning record above. Do not set `PUBLISHING_ENABLED=true` on the public production Worker until a positive private preflight verifies the App permissions and repository-scoped token. Before Soyuz publication, Soyuz needs a durable publication record, immutable request fingerprint, claim-fenced artifact authorization and retention; the executor needs to produce the v1 manifest. Then deploy a compatible receiver, configure the private `KIRISAME` binding only in Soyuz, and enable dispatch in a separate change. Never use the public Worker URL as Soyuz's integration endpoint. See [GitHub App setup](GITHUB-APP.md).
