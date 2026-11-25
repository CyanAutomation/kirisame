# Phase 0.1 through Phase 2A status

Phase 0.1 contract hardening, Phase 1 Worker foundations, Phase 1.1 publication hardening, Phase 2A GitHub App integration, and the authenticated caller-key receiver are implemented and deployed. The authenticated preflight and App-scope probe passed, and the canary replay reused PR #128. Production has no receiver-side repository allowlist; only the fixed private live-canary invoker is currently authorized. Soyuz's publication ledger is deployed with migration `0009`; its private binding is implemented in source with dispatch disabled. The Kaseki producer is implemented in source but its trusted-host rollout is pending.

## Implemented

- Strict TypeScript Worker using the Cloudflare `cf` CLI, `cloudflare.config.ts`, Vite, and Workers Vitest integration.
- Reusable TypeScript contract validators generated from the canonical JSON Schemas; contract and Worker suites share the validation rules.
- Semantic checks for artifact provenance, canonical digests/base64, decoded byte limits, paths, workflow restrictions, stable error taxonomy, result/request identity, and lifecycle event combinations.
- Private typed `PublisherEntrypoint.publish(requestJson, callerId, apiKey)` RPC with per-caller Worker secret authentication and a 9 MiB UTF-8 cap before JSON parsing. Credentials remain outside the immutable v1 request. The test-only mock entrypoint is excluded from production exports.
- Public `GET /`, `/health`, and `/readyz` diagnostics. The public Worker never dispatches to publication; `/internal/v1/publications` returns 404.
- Git-compatible deterministic mock blobs, trees, commits, nested paths, and refs with reconciliation and fault injection.
- No-op publication rejection before object writes, `.gitattributes` mutation rejection, pinned base-tree LFS checks, and fail-closed handling for unsupported Git attributes.
- Publication commit/PR markers bind the publication/run/artifact and a digest of the complete immutable request. PR reconciliation checks repository, refs, URL, title, body, state, and marker.
- Workers-compatible GitHub App RS256 JWT signing with unencrypted PKCS#1 and PKCS#8 PEM support.
- Installation resolution with App/owner/suspension/permission checks; exact requested-repository token scope; operation-specific permissions; token repository, permission, and expiry validation.
- Real GitHub REST Git Data and Pull Requests adapter with fixed API origin/version, bounded request/response sizes, timeouts, rate-limit handling, Git SHA verification, nested tree traversal, truncated-tree rejection, PR pagination, and structured errors.
- No Kirisame repository allowlist. Authenticated callers own destination authorization; Soyuz retains its own repository policy. Production factory has no mock fallback and is gated by `PUBLISHING_ENABLED=true`.
- Unit, Worker runtime, injected HTTP adapter, and HTTP-backed publication service tests. Normal CI requires no live GitHub or Cloudflare credentials.

## Runtime and deployment configuration

The Worker is named `kirisame`, targets account `c40f3cb30efbf8c6d081cf9e50a61931`, and uses `https://kirisame.scheimann.workers.dev/`. Configuration is in [cloudflare.config.ts](../cloudflare.config.ts). The checked-in settings explicitly disable publishing, set App ID `3345400`, leave the optional Client ID empty, and declare the App key and `KIRISAME_CALLER_KEYS` as Worker secrets. No repository allowlist is configured in the target source.

The public Worker reports publishing unavailable unless the commissioning gate and configuration are valid. Readiness validates configuration only; it does not contact GitHub or prove that an installation is usable. The named publisher uses the real adapter only when explicitly enabled and never falls back to the mock. Production has an existing App key secret binding and App installation. Its publishing gate is enabled only for the exact Somatic PR-to-`main` rule. Production Soyuz has not yet received the binding declared in its source config.

See [Operations](OPERATIONS.md) for local commands, deployment preflight, diagnostics, and rollback. The private Soyuz binding is named `KIRISAME`; the public URL is not the integration endpoint.

## Developer commands

Use Node.js 22.23.0 or newer supported by the Cloudflare CLI. The checks below need no external GitHub or Cloudflare credentials:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm audit
```

`npm test` runs contract, Workers runtime, authentication, HTTP adapter, and simulated end-to-end publication suites. `npm run build` and `npm run typecheck` use the Cloudflare `cf` build. `cf dev` and `cf build` use the Cloudflare Vite plugin and `cloudflare.config.ts`; no Wrangler configuration is maintained.

## Reconciliation policy

For every authenticated request, the application validates the contract, provenance, and artifact before GitHub state reads. The caller chooses and authorizes the repository. Kirisame resolves the App installation for that repository and validates the operation-scoped token. It reads the deterministic publication ref before the current target base ref. A matching branch and matching open PR are confirmed success even after the target branch advances. If no branch exists, the current base must still equal the requested `baseSha` before any Git object is written. If a valid branch has no PR, PR creation requires a fresh base equality check. No-op artifacts are rejected before object creation. The publisher never silently rebases, force-updates a ref, or overwrites a conflicting branch. See [Lifecycle](LIFECYCLE.md) and [ADR 0007](adr/0007-idempotency-reconciliation.md).

## Remaining Soyuz integration gates

- The App owner accepts the current all-repositories installation and permission grants; this installation scope does not restrict repositories. Soyuz currently controls its target with a Somatic PR-to-`main` caller policy.
- Keep the existing `kirisame` Worker and its private-key secret in Cloudflare. Do not copy the key to Kaseki or the coding container.
- Production D1 already records Soyuz migration `0009`. Soyuz source declares the private `KIRISAME` binding, caller ID and `KIRISAME_API_KEY` secret requirement, Somatic PR-to-`main` caller policy, and `PUBLICATION_DISPATCH_ENABLED=false`; roll out only after producer-host readiness is verified.
- Kaseki source now pins the base SHA, persists a per-run publication route, suppresses direct publishing for the Somatic PR-to-`main` Kirisame route, and uploads the claim-bound manifest/evidence. The trusted execution host still needs the rollout and host preflight.
- Configure distinct caller API keys, run authenticated App preflight and App-scope probe, then run a new canonical end-to-end canary with a new run/publication ID and the legacy publisher disabled for that run. Verify manifest upload, validation evidence, intent, D1 events, private RPC result, PR creation, identical replay, and that retryable/blocked states cannot extend the canonical 90-day run deadline.
- Keep merging or cleaning up the canary PR manual. Do not add a second publication journal or Durable Object to Kirisame.
- Migrate Kaseki publication in a staged cutover. Rusty-Fossil will use the same contract when its executor exists.

Keep Soyuz dispatch off until these controls and cross-repository rollout are reviewed. Do not change Soyuz, Kaseki-Agent, or Rusty-Fossil in a Kirisame-only implementation change.
