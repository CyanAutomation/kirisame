# Operations

## Current production state

The safe GitHub App adapter build was deployed to `https://kirisame.scheimann.workers.dev/` on 2026-11-22 (Cloudflare deployment ID `1e83c0cb-3088-4ab0-9ff8-d90076507133`). It contains only the `PUBLISHING_ENABLED=false`, App ID, empty Client ID, and empty allowlist text bindings. No GitHub App secret, installation, approved repository, storage binding or Soyuz binding is configured. Public verification returned `/` 200 with publishing unavailable, `/health` 200, `/readyz` 503, and a forged POST to `/internal/v1/publications` 404. The private RPC returns `PUBLISHING_UNAVAILABLE` for valid publication requests; the public HTTP handler cannot reach it.

The prior diagnostics-only deployment was created on 2026-11-21. The Cloudflare account subdomain is `scheimann`; the safe 2026-11-22 upload updated the existing `kirisame` Worker.

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

The private `PublisherEntrypoint.publish(requestJson)` method is a typed RPC surface. It is not an HTTP route and is not callable through the `workers.dev` URL. When a future Soyuz Service Binding is configured, name it `KIRISAME` and attach it only to Soyuz. This binding is not present in the current deployment configuration.

If a future HTTP facade is explicitly approved, map contract outcomes to transport statuses consistently: invalid input `400`, policy denial `403`, conflict `409`, `GITHUB_RATE_LIMITED` `429` with `Retry-After`, other retryable failures `503`, `PUBLISHING_UNAVAILABLE` `501`, and internal failures `500`. Keep the structured v1 body unchanged. This mapping does not apply to typed RPC responses.

## Observability and safe diagnostics

Workers Observability logs and traces are enabled in the Worker configuration with sampling. Runtime logs contain only the operation name, generated request ID, publication/run IDs, mode, outcome, retryability, reconciliation result, safe GitHub API category/status and duration. API category logs do not include owner/repository paths. Never add repository content, artifact bytes, authorization headers, GitHub response bodies, private keys, tokens or stack traces to logs. Investigate through the Cloudflare dashboard's Worker logs and traces; keep repository and request identifiers out of metric labels.

## Rollback

Use the Cloudflare dashboard: **Workers & Pages → kirisame → Deployments**, select the last known-good version and choose **Rollback**. A rollback creates a new deployment that routes traffic to the selected version. Then repeat the public diagnostics checks above and confirm `/readyz` still reports publishing unavailable. No external binding or data resource is configured in this phase, so there is no publication state to migrate. See Cloudflare's [Worker rollback guidance](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Production publishing prerequisites

The GitHub App adapter and reconciliation are implemented, but no live App configuration or canary has been approved. Do not set `PUBLISHING_ENABLED=true` on the public production Worker as a substitute for an isolated private canary. Before Soyuz publication, Soyuz needs a durable publication record, immutable request fingerprint, claim-fenced artifact authorization and retention; the executor needs to produce the v1 manifest. Then deploy a compatible receiver, configure the private `KIRISAME` binding only in Soyuz, and enable dispatch in a separate change. Never use the public Worker URL as Soyuz's integration endpoint. See [GitHub App setup](GITHUB-APP.md).
