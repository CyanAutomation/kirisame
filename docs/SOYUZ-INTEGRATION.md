# Soyuz integration contract

## Private typed RPC interface

### Default publication policy

Omitting `publishMode` means `pr` across Soyuz REST, agent/UTCP calls, Kaseki API/CLI/worker requests, and Rusty-Fossil's normalized queue parser. Kirisame's `mode` field remains required so the trusted boundary never guesses the operation; `pr` is its documented client default. Other values are explicit exceptions for narrowly scoped tests. Do not use `auto` or `none` to mask unavailable GitHub credentials. Soyuz resolves `none` without calling Kirisame.

Soyuz is the only intended publication client. Kirisame exports a separate named `PublisherEntrypoint` with the typed RPC method `publish(requestJson: string)`. The deployment has no configured Service Binding yet, and no caller is connected. The public HTTP handler cannot reach this named entrypoint.

The private RPC accepts a JSON serialization of the strict [publication request v1](../contracts/v1/publication-request.schema.json), including its inline immutable manifest and `artifactDigest`. It measures the UTF-8 payload against a 9 MiB cap before parsing. The response is either the strict [publication result v1](../contracts/v1/publication-result.schema.json) or the strict [publication error v1](../contracts/v1/publication-error.schema.json). The version is the literal string `1` in the JSON body; it is independent of either repository's package version. Unknown versions, unknown properties and unsupported operations fail closed. The RPC method has no HTTP media type or status code; do not wrap it in the public `fetch()` handler.

The test-only `MockPublisherEntrypoint` injects the mock adapter and is excluded from the production Worker entrypoint. In production, a valid request returns `PUBLISHING_UNAVAILABLE`; publishing is not enabled. When integration prerequisites are met, use the binding name `KIRISAME` consistently, configure it only on Soyuz, and deploy in receiver-first order: deploy a compatible Kirisame receiver, attach the binding in Soyuz, then enable Soyuz dispatch. Soyuz must retry the same immutable request and publicationId. A contract change that cannot be safely additive requires a new v2 schema and RPC method; deploy the receiver before the caller.

## Caller identity and authorization

The Service Binding will provide the initial caller boundary. Deployment config must attach it only to Soyuz and keep the publisher off every public route. Do not accept caller identity from headers or body fields. Do not use Kaseki's worker bearer token or Soyuz's public client token as a substitute for binding isolation.

Before each publication, Soyuz must:

1. Load the canonical run by UUIDv7, not its display ID.
2. Confirm the run is completed under the trusted execution protocol and retrieve claim-fenced validation evidence. A completion callback's optional publishedUrl is legacy output, not authorization proof.
3. Resolve the destination repository, publication target branch and exact base commit from canonical run data and validated executor evidence.
4. Resolve publishMode. An omitted mode becomes pr. `none` results in no Kirisame call and is reserved for an explicitly scoped test; `auto` is likewise a rare explicit test exception. For ordinary publication, send `pr`. `branch` is permitted only for a test that specifically exercises branch-only behavior.
5. Create and persist a unique publicationId and immutable request fingerprint, associate the retained artifact with runId, and reserve one attempt using a D1 compare-and-set.
6. Send only the request authorized by that record.

Kirisame trusts the call as coming from Soyuz because of the binding deployment, then independently validates the contract, artifact provenance, repository allowlist, installation selection, branch policy and GitHub operations. It never accepts validationPassed or a similar caller assertion as sufficient evidence.

## Run and artifact compatibility

The current canonical run ID is a Soyuz-generated UUIDv7. Its displayId, such as soyuz-N, is human-facing and must never appear in runId or artifact provenance. Kaseki's historical local kaseki-N ID is also not canonical.

Soyuz's regular POST /v1/runs route already defaults publishMode to pr; the accompanying change aligns POST /v1/agent/runs and UTCP, which previously defaulted to none. Kaseki controller/API/worker defaults are pr; the accompanying change aligns its CLI and built-in configuration fallback, which previously used auto. Kaseki's explicit auto mode can skip publication when credentials are unavailable, so it is not a safe normal default. Rusty-Fossil already defaults a missing normalized queue value to pr. In the new design, Soyuz resolves any explicitly requested test exception before Kirisame receives an operation; Kirisame requires an explicit branch or pr mode. See the [Soyuz request contract](https://github.com/CyanAutomation/soyuz/blob/main/docs/CONTRACT.md), [agent run implementation](https://github.com/CyanAutomation/soyuz/blob/main/src/api/agent-runs.ts), [Kaseki API types](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/kaseki-api-types.ts), and [Kaseki publish settings](https://github.com/CyanAutomation/kaseki-agent/blob/main/docs/ENV_VARS.md).

Current Soyuz stores generic artifacts uploaded with the worker ID and claim callback fence. It does not yet store the v1 file-change manifest, publicationId, exact base commit or artifact digest described here. Current Kaseki sends summary, failure JSON, diff, changed-file list, scorecard and evaluation artifacts; it does not currently send this immutable manifest to Soyuz. Rusty-Fossil has no coding executor yet. Both executor integrations must converge on the same executor-neutral manifest and Soyuz provenance protocol.

Kaseki's current publication step is part of its executor workflow: it obtains an installation token, creates a local commit, pushes `kaseki/$INSTANCE_NAME` with `--force-with-lease`, and then optionally creates a PR. Its PR helper retries selected create failures. During migration, Kaseki must stop receiving or reading the GitHub App private key for new Soyuz-authorized publications, upload only the immutable change manifest and validation evidence, and let Soyuz call Kirisame after execution completes. The deterministic Kirisame ref is `kirisame/p/{publicationId}` and is create-only; the old branch naming, local Git commit/push and force-with-lease behavior are not carried forward. Existing legacy runs may keep their current publication path until the caller-side migration is enabled, but a single publicationId must never be handled by both publishers.

The current Soyuz R2 objects expire after 30 days and runs are culled after the newest-30 history window. Before enabling publication, Soyuz must pin a publication artifact while its publication is pending or retryable and retain the publication record independently of run-row retention. This is necessary if a run completes well before a GitHub operation succeeds.

## Execution outcome and publication outcome

Soyuz's current worker completed callback accepts exitCode 0, summary, optional publishedUrl, changedFileCount and outcomeSummary. Kaseki runs GitHub publishing as a stage before its terminal callback and derives publishedUrl from its local result metadata. Soyuz has no independent publication record today. See [Soyuz worker callbacks](https://github.com/CyanAutomation/soyuz/blob/main/src/contracts/worker-callbacks.ts), [Soyuz architecture](https://github.com/CyanAutomation/soyuz/blob/main/docs/ARCHITECTURE.md), and [Kaseki Soyuz adapter](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/integrations/soyuz/soyuz-artifacts.ts).

The future integration must record two outcomes:

**Execution outcome:** Did the executor complete and did Soyuz accept trusted validation evidence?

**Publication outcome:** Did Kirisame confirm the requested branch or open PR?

A successful execution remains completed if GitHub publication later fails. Soyuz must add a separate publication record and state model rather than changing existing run terminal states or overloading the completion callback. Phase 0 does not alter current run states or callback schemas. During staged migration, legacy Kaseki may continue populating publishedUrl; new Kirisame results are stored in the separate publication record and are not treated as execution completion data.

## Failure and retry behavior

Soyuz persists publishing before the binding call. On a definite Kirisame result, it records the returned outcome and event. On network timeout, caller cancellation or lost response, it records retryable_failure with reconciliation unknown and retries the same immutable request after backoff. Kirisame reads branch and PR state before every potentially repeated mutation. A policy denial, unsupported input, base movement or unrelated branch is blocked and does not trigger automatic retries.

Proposed initial budgets are a 120-second Service Binding call timeout, 15 seconds per GitHub request, and durable retries with exponential backoff plus jitter starting at 2 seconds and capped at 5 minutes. Honor GitHub Retry-After up to one hour. After three immediate transient failures, leave the request to Soyuz's durable scheduler. These are design defaults to validate before implementation, not runtime behavior.

Soyuz owns publication records, CAS dispatch leases, retry timing and append-only events. Kirisame does not need its own journal for the first implementation if Soyuz enforces the immutable fingerprint and serializes dispatches. A retry of the exact POST causes Kirisame to reconcile GitHub. A separate Kirisame status endpoint would require its own durable operation store and is not part of v1.

## Deployment compatibility

Soyuz and Kirisame are independently deployed. Each side validates its own contract and pins support to version 1. New required fields or changed field meanings require a new version. Unknown versions and unrecognized security-sensitive fields are rejected. For rollout and rollback, first deploy the receiver with backward-compatible acceptance, then enable the caller; disable caller dispatch before rolling back a receiver that no longer supports the contract.

Do not change Soyuz run callbacks, terminal states, Queue contracts, or executor credentials in the Kirisame implementation. Before end-to-end publishing, update Soyuz's publication model and artifact retention, then integrate Kaseki and the future Rusty-Fossil executor as described in [Phase 0.1 and Phase 1 status](PHASE1-PLAN.md).
