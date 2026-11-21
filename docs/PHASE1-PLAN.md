# Phase 0.1 and Phase 1 status

Phase 0.1 contract hardening and the Phase 1 Cloudflare Worker foundation are implemented. The diagnostics-only Worker was deployed on 2026-11-21 and verified at `https://kirisame.scheimann.workers.dev/`; GitHub publishing remains disabled. Soyuz is not connected, and no GitHub credentials or production Service Binding are configured.

## Implemented

- Strict TypeScript and ESM project using NPM, the Cloudflare `cf` CLI, `cloudflare.config.ts`, Vite and Cloudflare Workers Vitest integration.
- Reusable TypeScript validators generated from the canonical JSON Schemas. Node contract tests and the Worker runtime use the same validation rules.
- Semantic checks for artifact provenance, canonical digest and base64, decoded byte limits, paths, workflow restrictions, stable error taxonomy, result/request identity and lifecycle event combinations.
- Typed private `PublisherEntrypoint.publish(requestJson)` RPC. It accepts a JSON string, enforces the 9 MiB UTF-8 request cap before parsing, validates v1, and returns a typed result or structured error. The test-only mock publisher is in the test Worker entrypoint and is not part of the production export.
- Public `GET /`, `GET /health` and `GET /readyz` diagnostics. The public Worker never dispatches to the publisher; `/internal/v1/publications` returns 404.
- Allowlisted publication policy, narrow GitHub adapter interface and deterministic in-memory mock with reconciliation and fault injection.
- Deterministic branch and pull-request publication tests. The implementation uses create-only refs, validates the full expected tree and reconciles ambiguous mutations; it does not promise exactly-once writes.
- CI for pull requests and `main`, with pinned GitHub Actions, least-privilege permissions and no Cloudflare or GitHub secrets.

## Runtime and deployment configuration

The Worker is named `kirisame`, targets account `c40f3cb30efbf8c6d081cf9e50a61931`, and uses `https://kirisame.scheimann.workers.dev/`. Before deployment, Cloudflare confirmed the account's `scheimann` workers.dev subdomain and no existing Worker named `kirisame`; deployment then created the Worker with previews disabled. Configuration is in [cloudflare.config.ts](../cloudflare.config.ts).

The public Worker reports publishing as unavailable. The named RPC entrypoint returns the contract error `PUBLISHING_UNAVAILABLE` for valid requests. No mock adapter is instantiated in the production entrypoint. There is no GitHub adapter, App key, installation ID, D1, R2, KV, Queue, Workflow, Durable Object or production Service Binding configured.

See [Operations](OPERATIONS.md) for local commands, diagnostics, deployment checks and rollback. A future Soyuz binding is documented as `KIRISAME`; the public URL is not the integration endpoint.

## Developer commands

Use Node.js 22.23.0 or newer within the Node 22 line; the current `cf` release candidate requires it.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run dev
```

`npm test` runs contract and Worker runtime suites. `npm run build` and `npm run typecheck` use the Cloudflare `cf` build. The checks need no external GitHub or Cloudflare credentials. `cf dev` and `cf build` use the Cloudflare Vite plugin and `cloudflare.config.ts`; no Wrangler configuration is maintained.

## Reconciliation policy

For every valid request, the application validates the contract, provenance, artifact and repository policy before reading publication state. It reads the deterministic publication ref before the current target base ref. A matching branch and matching open PR are confirmed success even after the target branch advances. If no branch exists, the current base must still equal the requested `baseSha` before any Git object is written. If a valid branch has no PR, PR creation requires a fresh base equality check. The publisher never silently rebases, force-updates a ref or overwrites a conflicting branch. See [Lifecycle](LIFECYCLE.md) and [ADR 0007](adr/0007-idempotency-reconciliation.md).

## Prerequisites before real publishing

Real GitHub publication and Soyuz integration remain later work:

- Add a Soyuz publication record with unique `publicationId`, immutable request fingerprint, attempt lease/fence, retry time, outcome history and artifact retention pin.
- Record and verify trusted completion and validation evidence before dispatch; do not authorize from an executor-supplied boolean.
- Produce the v1 immutable file-change manifest in executors and bind it to the canonical run and current claim fence.
- Configure a least-privilege Kirisame GitHub App installation and secret rotation process.
- Implement and test a real GitHub adapter, bounded outbound timeouts, and reconciliation against live API semantics.
- Add the `KIRISAME` Service Binding to Soyuz only after the receiver contract is deployed and reviewed; then enable caller dispatch separately.
- Migrate Kaseki publication in a staged cutover. Rusty-Fossil will use the same contract when its executor exists.

Do not enable GitHub writes until these controls and a cross-repository rollout are reviewed. Do not change Soyuz, Kaseki-Agent or Rusty-Fossil in this repository's implementation PR.
