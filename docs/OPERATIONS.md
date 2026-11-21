# Operations

## Current production state

Kirisame is deployed as a diagnostics-only Worker at `https://kirisame.scheimann.workers.dev/` (2026-11-21). It has no GitHub App secret, installation ID, live GitHub adapter, storage binding or Soyuz binding. The public Worker reports publishing as unavailable; the named production RPC returns `PUBLISHING_UNAVAILABLE` for valid publication requests. The public HTTP handler cannot reach the publisher.

The deployment was verified: `/` returned 200 with publishing unavailable, `/health` returned 200, `/readyz` returned 503 with publishing unavailable, and a forged public POST to `/internal/v1/publications` returned 404. The Cloudflare account subdomain was `scheimann`, and no Worker named `kirisame` existed before this deployment.

The intended Worker is `kirisame` at `https://kirisame.scheimann.workers.dev/`, in Cloudflare account `c40f3cb30efbf8c6d081cf9e50a61931`. `cloudflare.config.ts` is the project configuration. The repository uses Cloudflare's `cf` CLI and Cloudflare Vite plugin; it does not maintain Wrangler configuration. Cloudflare CLI `cf` and its configuration are in release-candidate status, so keep the lockfile committed and review CLI/plugin upgrades.

## Local development and checks

Use Node.js 22.23.0 or newer within Node 22, then run:

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
```

`npm test` runs the contract suite and the Cloudflare Workers runtime suite. These checks use the test-only mock publisher and do not need Cloudflare credentials, GitHub credentials or network access to a live repository.

## Deployment preflight and deployment

Deploy only after all checks above pass. Before an initial deployment, verify all of the following in the intended account:

1. The account ID matches `c40f3cb30efbf8c6d081cf9e50a61931`.
2. The account's `workers.dev` subdomain is `scheimann`.
3. A Worker named `kirisame` does not exist, or its current deployment and ownership have been reviewed and it is safe to replace.
4. The build has no GitHub authentication secret, repository data binding or Soyuz Service Binding.
5. `PublisherEntrypoint` in the production bundle returns `PUBLISHING_UNAVAILABLE`; the mock publisher exists only in `tests/worker/test-entrypoint.ts`.

Build and deploy with:

```sh
npm run build
npm run deploy
```

`npm run deploy` invokes `cf deploy`. Authenticate with `cf auth login` or a scoped `CLOUDFLARE_API_TOKEN`; do not put credentials in source control. Review the `cf deploy` target account and Worker name before confirming deployment. Deployment is intentionally manual; CI never deploys.

After deployment, check the public responses:

```sh
curl -i https://kirisame.scheimann.workers.dev/
curl -i https://kirisame.scheimann.workers.dev/health
curl -i https://kirisame.scheimann.workers.dev/readyz
curl -i https://kirisame.scheimann.workers.dev/internal/v1/publications
```

Expected behavior: `/` returns only service identity and `publishing: unavailable`; `/health` returns `200` and `status: ok`; `/readyz` returns `503` and `status: not_ready`; the private HTTP path returns `404`. Unsupported methods on the diagnostic routes return `405`. Headers such as `Authorization` or `x-soyuz-service` never grant publishing access.

The private `PublisherEntrypoint.publish(requestJson)` method is a typed RPC surface. It is not an HTTP route and is not callable through the `workers.dev` URL. When a future Soyuz Service Binding is configured, name it `KIRISAME` and attach it only to Soyuz. This binding is not present in the current deployment configuration.

If a future HTTP facade is explicitly approved, map contract outcomes to transport statuses consistently: invalid input `400`, policy denial `403`, conflict `409`, `GITHUB_RATE_LIMITED` `429` with `Retry-After`, other retryable failures `503`, `PUBLISHING_UNAVAILABLE` `501`, and internal failures `500`. Keep the structured v1 body unchanged. This mapping does not apply to typed RPC responses.

## Observability and safe diagnostics

Workers Observability logs and traces are enabled in the Worker configuration with sampling. Runtime logs contain only the operation name, generated request ID, publication ID and outcome or safe error code/classification. Never add repository content, artifact bytes, authorization headers, GitHub response bodies, private keys, tokens or stack traces to logs. Investigate through the Cloudflare dashboard's Worker logs and traces; keep repository and request identifiers out of metric labels.

## Rollback

Use the Cloudflare dashboard: **Workers & Pages → kirisame → Deployments**, select the last known-good version and choose **Rollback**. A rollback creates a new deployment that routes traffic to the selected version. Then repeat the public diagnostics checks above and confirm `/readyz` still reports publishing unavailable. No external binding or data resource is configured in this phase, so there is no publication state to migrate. See Cloudflare's [Worker rollback guidance](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Production publishing prerequisites

Do not enable live GitHub writes until the prerequisites in [Phase 0.1 and Phase 1 status](PHASE1-PLAN.md) are complete and reviewed. At minimum, Soyuz needs a durable publication record, immutable request fingerprint, claim-fenced artifact authorization and retention; the executor needs to produce the v1 manifest; and Kirisame needs a scoped GitHub App adapter and tested reconciliation. Deploy the receiver first, configure the private `KIRISAME` binding only in Soyuz, and enable Soyuz dispatch in a separate change. Never use the public Worker URL as Soyuz's integration endpoint.
