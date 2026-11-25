# Soyuz integration contract

## Private typed RPC interface

### Default publication policy

Omitting `publishMode` means `pr` across Soyuz REST, agent/UTCP calls, Kaseki API/CLI/worker requests, and Rusty-Fossil's normalized queue parser. Kirisame's `mode` field remains required so the trusted boundary never guesses the operation; `pr` is its documented client default. Other values are explicit exceptions for narrowly scoped tests. Do not use `auto` or `none` to mask unavailable GitHub credentials. Soyuz resolves `none` without calling Kirisame.

Soyuz is the intended publication client. Kirisame exports a separate named `PublisherEntrypoint` with the typed RPC method `publish(requestJson: string, callerId: string, apiKey: string)`. The v1 request remains unchanged; caller credentials are separate RPC arguments and do not affect its canonical digest. Production Soyuz's merged source declares `KIRISAME` to this entrypoint with dispatch disabled. The public HTTP handler cannot reach this named entrypoint.

The private RPC accepts a JSON serialization of the strict [publication request v1](../contracts/v1/publication-request.schema.json), including its inline immutable manifest and `artifactDigest`. It measures the UTF-8 payload against a 9 MiB cap before parsing. The response is either the strict [publication result v1](../contracts/v1/publication-result.schema.json) or the strict [publication error v1](../contracts/v1/publication-error.schema.json). The version is the literal string `1` in the JSON body; it is independent of either repository's package version. Unknown versions, unknown properties and unsupported operations fail closed. The RPC method has no HTTP media type or status code; do not wrap it in the public `fetch()` handler.

The test-only `MockPublisherEntrypoint` injects the mock adapter and is excluded from the production Worker entrypoint. Code defaults remain fail-closed. The last deployed Kirisame release used a Somatic PR-to-`main` allowlist; the target Kirisame receiver has none. Soyuz retains its caller-side `PUBLICATION_REPOSITORY_ALLOWLIST` for Somatic PRs to `main`. Soyuz's ledger, attempt fencing, events, retry recovery, and manifest retention are implemented and deployed; production D1 records migration `0009`. Soyuz source declares the private binding and dispatch disabled. The trusted Kaseki producer is implemented in source but still needs execution-host rollout. Keep dispatch off until caller secrets, host preflight, and the no-dual-publisher check pass. Soyuz retries the same immutable request and publicationId. A v1 payload change requires a new contract version; this authentication update changes only the private RPC arguments.

## Caller identity and authorization

The private Service Binding and a distinct API key jointly identify Soyuz. Kirisame keeps accepted caller keys in the `KIRISAME_CALLER_KEYS` secret. Soyuz stores `KIRISAME_API_KEY` as a Worker secret and sends caller ID `soyuz` in a separate RPC argument. Do not accept caller identity from headers or the v1 body. Do not use Kaseki's worker bearer token or Soyuz's public client token as a substitute for this caller credential.

Before each publication, Soyuz must:

1. Load the canonical run by UUIDv7, not its display ID.
2. Confirm the run is completed under the trusted execution protocol and retrieve claim-fenced validation evidence. A completion callback's optional publishedUrl is legacy output, not authorization proof.
3. Resolve the destination repository, publication target branch and exact base commit from canonical run data and validated executor evidence.
4. Resolve publishMode. An omitted mode becomes pr. `none` results in no Kirisame call and is reserved for an explicitly scoped test; `auto` is likewise a rare explicit test exception. For ordinary publication, send `pr`. `branch` is permitted only for a test that specifically exercises branch-only behavior.
5. Create and persist a unique publicationId and immutable request fingerprint, associate the retained artifact with runId, and reserve one attempt using a D1 compare-and-set.
6. Send only the request authorized by that record.

Kirisame authenticates the calling service, then validates the contract and artifact provenance. It has no repository allowlist: Soyuz controls repository selection through canonical run state and its caller-side policy before calling Kirisame. Kirisame independently checks the GitHub App installation and minimum permission scope for the requested repository. The current App install selects all repositories, so that selection does not narrow the requested repository; a selected-repository install would add that limit. Kirisame never accepts validationPassed or a similar caller assertion as sufficient evidence.

## Run and artifact compatibility

The current canonical run ID is a Soyuz-generated UUIDv7. Its displayId, such as soyuz-N, is human-facing and must never appear in runId or artifact provenance. Kaseki's historical local kaseki-N ID is also not canonical.

Soyuz's regular POST /v1/runs route already defaults publishMode to pr; the accompanying change aligns POST /v1/agent/runs and UTCP, which previously defaulted to none. Kaseki controller/API/worker defaults are pr; the accompanying change aligns its CLI and built-in configuration fallback, which previously used auto. Kaseki's explicit auto mode can skip publication when credentials are unavailable, so it is not a safe normal default. Rusty-Fossil already defaults a missing normalized queue value to pr. In the new design, Soyuz resolves any explicitly requested test exception before Kirisame receives an operation; Kirisame requires an explicit branch or pr mode. See the [Soyuz request contract](https://github.com/CyanAutomation/soyuz/blob/main/docs/CONTRACT.md), [agent run implementation](https://github.com/CyanAutomation/soyuz/blob/main/src/api/agent-runs.ts), [Kaseki API types](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/kaseki-api-types.ts), and [Kaseki publish settings](https://github.com/CyanAutomation/kaseki-agent/blob/main/docs/ENV_VARS.md).

Soyuz stores the v1 file-change manifest under the worker ID and claim callback fence, verifies its digest and provenance, and records publication intents, IDs, fingerprints, fenced attempts, events, retries, and retention pins independently of run culling. Production migration `0009` is applied. Kaseki source now builds the bounded v1 manifest from the pinned workspace, uploads it under the active claim, records validation evidence, and registers the publication intent before terminal completion. Its trusted execution host still needs the source rollout and producer feature flag; existing runs continue through the legacy route. Kaseki continues sending the generic summary, failure JSON, diff, changed-file list, scorecard, and evaluation artifacts. Rusty-Fossil has no coding executor yet. Both executor integrations must use the same executor-neutral manifest and Soyuz provenance protocol.

Kaseki's legacy direct publisher remains available to runs recorded with `publicationRoute: legacy`. For a newly selected Kirisame route, Kaseki pins the base SHA before execution, persists the route for that run, sets `KASEKI_PUBLISH_MODE=none`, and removes GitHub App and Soyuz/Cloudflare credentials from the executor environment. The trusted host creates and uploads the immutable change manifest plus validation evidence, then lets Soyuz call Kirisame after execution completes. The deterministic Kirisame ref is `kirisame/p/{publicationId}` and is create-only; the old branch naming, local Git commit/push and force-with-lease behavior are not carried forward. A run uses one persisted route, so its publication cannot be handled by both publishers.

Generic Soyuz R2 objects expire after 30 days and runs are culled after the newest-30 history window. Publication manifests are stored separately and pinned across pending, retryable, and blocked states, independent of run-row retention; published manifests are retained for at least 30 days after confirmation.

## Execution outcome and publication outcome

Soyuz's worker completed callback still accepts an optional legacy `publishedUrl`. The new ledger stores publication outcome separately from run completion, and the new Kaseki route must not populate `publishedUrl` or call the direct publisher. See [Soyuz worker callbacks](https://github.com/CyanAutomation/soyuz/blob/main/src/contracts/worker-callbacks.ts), [Soyuz architecture](https://github.com/CyanAutomation/soyuz/blob/main/docs/ARCHITECTURE.md), and [Kaseki Soyuz adapter](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/integrations/soyuz/SoyuzAdapter.ts).

The future integration must record two outcomes:

**Execution outcome:** Did the executor complete and did Soyuz accept trusted validation evidence?

**Publication outcome:** Did Kirisame confirm the requested branch or open PR?

A successful execution remains completed if GitHub publication later fails. Soyuz's separate publication record and state model do not change existing run terminal states or overload the completion callback. During staged migration, legacy Kaseki may continue populating `publishedUrl`; new Kirisame results are stored in the separate publication record and are not treated as execution completion data.

## Failure and retry behavior

Soyuz persists publishing before the binding call. On a definite Kirisame result, it records the returned outcome and event. On network timeout, caller cancellation or lost response, it records retryable_failure with reconciliation unknown and retries the same immutable request after backoff. Kirisame reads branch and PR state before every potentially repeated mutation. A policy denial, unsupported input, base movement or unrelated branch is blocked and does not trigger automatic retries.

`APP_NOT_INSTALLED` and `GITHUB_PERMISSION_DENIED` are policy errors: Soyuz records a blocked publication and does not retry it on the scheduler. Correct the GitHub App installation or minimum permission grant, rerun the read-only preflight, inspect the blocked publication's branch/PR state, then use an explicitly authorized recovery. Installation/token preflight failures happen before branch creation. If GitHub revokes permission mid-request, inspect for a branch before issuing another publication; leave any partial branch for manual review.

Proposed initial budgets are a 120-second Service Binding call timeout, 15 seconds per GitHub request, and durable retries with exponential backoff plus jitter starting at 2 seconds and capped at 5 minutes. Honor GitHub Retry-After up to one hour. After three immediate transient failures, leave the request to Soyuz's durable scheduler. These are design defaults to validate before implementation, not runtime behavior.

Soyuz owns publication records, CAS dispatch leases, retry timing and append-only events. Kirisame does not need its own journal for the first implementation if Soyuz enforces the immutable fingerprint and serializes dispatches. A retry of the exact POST causes Kirisame to reconcile GitHub. A separate Kirisame status endpoint would require its own durable operation store and is not part of v1.

## Deployment compatibility

Soyuz and Kirisame are independently deployed. Each side validates its own contract and pins support to version 1. New required fields or changed field meanings require a new version. Unknown versions and unrecognized security-sensitive fields are rejected. For rollout and rollback, first deploy the receiver with backward-compatible acceptance, then enable the caller; disable caller dispatch before rolling back a receiver that no longer supports the contract.

Do not change Soyuz run callbacks, terminal states, Queue contracts, or executor credentials in the Kirisame implementation. Before end-to-end publishing, update Soyuz's publication model and artifact retention, then integrate Kaseki and the future Rusty-Fossil executor as described in [Phase 0.1 and Phase 1 status](PHASE1-PLAN.md).
