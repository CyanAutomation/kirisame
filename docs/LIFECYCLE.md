# Publication lifecycle, idempotency and reconciliation

Soyuz is the canonical owner of publication state. This lifecycle is independent of a coding run's execution state.

## States and ownership

| State | Meaning | Owner action |
| --- | --- | --- |
| pending | Soyuz authorized a publication and retained the immutable artifact; no attempt is active. | Soyuz dispatches after a compare-and-set reservation. |
| publishing | Soyuz reserved an attempt and a Kirisame call may have changed GitHub state. | Kirisame returns a result; Soyuz owns the transition. |
| published | The requested branch is confirmed, and for mode pr an open matching PR is confirmed. | Soyuz stores the final branch/commit/PR identifiers and event. |
| retryable_failure | A transient failure or uncertain mutation remains safe to reconcile and retry. | Soyuz retains the artifact and schedules the same request identity. |
| blocked | A permanent conflict, invalid artifact, policy denial or unsupported operation prevents this publication. | Soyuz records the error; a changed request requires a new publicationId. |

The same branch-published outcome is a complete success only for mode branch. For mode pr, a confirmed branch without a confirmed open PR is partial progress, not published. No new execution state is introduced.

~~~mermaid
stateDiagram-v2
  [*] --> pending
  pending --> publishing: Soyuz reserves publication attempt
  publishing --> published: Requested branch/PR confirmed
  publishing --> retryable_failure: Transient or uncertain outcome
  publishing --> blocked: Permanent conflict or policy rejection
  retryable_failure --> publishing: Same immutable request after backoff
  blocked --> [*]: New authorization uses a new publicationId
  published --> [*]
~~~

The publication event schema is [publication-event.schema.json](../contracts/v1/publication-event.schema.json). Soyuz persists events and transitions. A Kirisame response is evidence for a transition, not a second canonical lifecycle.

## Publication identity and request equality

publicationId is a stable Soyuz-generated UUIDv7 identity for one authorized operation. Soyuz stores a request fingerprint over the complete normalized request, including mode, repository, baseRef/baseSha, headRef, PR title/body, artifactId and artifactDigest. It enforces a unique publicationId and rejects reuse with a different fingerprint. Retrying an operation means resending the exact immutable request and artifact with the same publicationId; changing the base, artifact, title, body or mode requires new authorization and a new publicationId.

Kirisame computes and validates the same artifact digest but has no durable operation database in the initial design. Deterministic refs and GitHub reconciliation make repeated calls safe only in combination with Soyuz's unique record and compare-and-set dispatch lease.

## Reconciliation rules

Before retrying any uncertain GitHub mutation, Kirisame reads remote state:

1. Validate the v1 request, caller binding, repository allowlist, artifact provenance, canonical digest and every file.
2. Resolve the GitHub App installation and obtain a token limited to the requested repository and required permissions.
3. Read the base ref. If it does not resolve to baseSha, return BASE_MOVED. Do not rebase or silently produce a different commit.
4. Read the deterministic head ref. If absent, read the base tree and check add/modify/delete expectations, then create the content-addressed blobs, tree and one-parent commit whose parent is baseSha.
5. Create the deterministic ref only if absent. If the create response is ambiguous, read the ref again. Reuse it only when the commit and publication marker match this request. A mismatch is BRANCH_CONFLICT; never force-update or delete it.
6. For mode branch, return branch_published after confirming the ref and commit.
7. For mode pr, list pull requests for the exact head and base, including closed PRs. If one open PR with the same publication marker exists, return it. If a closed/merged PR or unrelated/conflicting PR exists, return PULL_REQUEST_CONFLICT. If the list confirms absence, create the PR. If that response is ambiguous, list again and return the matching open PR if present.
8. If GitHub cannot be read during reconciliation, return retryable_failure with reconciliation unknown and a safe retry delay. Do not repeat the uncertain write until a later retry has reconciled again.

The GitHub REST Git Data API can create blobs, trees, commits and refs. Ref creation is deliberately create-only; updates are not used in v1. Pull requests are separately created and reconciled using head, base and a Kirisame publication marker. See [Git trees](https://docs.github.com/en/rest/git/trees), [Git commits](https://docs.github.com/en/rest/git/commits), [Git references](https://docs.github.com/en/rest/git/refs), and [Pull Requests](https://docs.github.com/en/rest/pulls/pulls).

## Required retry cases

| Situation | Required behavior |
| --- | --- |
| First request | Validate before mutation, pin baseSha, create content objects, create the deterministic ref, and optionally create/reconcile a PR. |
| Identical replay | Re-read GitHub state and return the matching branch/PR. Do not create another ref or PR. |
| Same publicationId with different content or metadata | Soyuz rejects by stored fingerprint. If Kirisame observes a ref/PR marker mismatch, return a permanent conflict. |
| Branch created, PR not created | Confirm the branch commit and marker; then create the PR only after a confirmed absence check. |
| PR created, response lost | Re-list by exact head/base and publication marker; return the existing PR. |
| Temporary token-service or connectivity failure | Classify as retryable only for timeout, network failure or service 5xx. Reconcile after any ambiguous mutation. A confirmed bad permission is blocked. |
| GitHub rate limiting | Return retryable with Retry-After when present. Soyuz waits; Kirisame does not busy-loop or exceed bounded attempts. |
| Base branch moves | Return BASE_MOVED and preserve any already-created branch. Do not create the PR against a different base SHA or rebase. A new attempt requires a newly authorized base/artifact and publicationId. |
| Pre-existing conflicting feature branch | Reuse only if marker, parent/base SHA and commit content all match. Otherwise return BRANCH_CONFLICT without modifying it. |
| Concurrent calls for one publicationId | Soyuz compare-and-set allows one active dispatcher. If a duplicate still reaches Kirisame, the deterministic ref create conflicts safely and it reconciles; GitHub PR uniqueness plus the marker prevents duplicate PRs. |

Do not claim exactly-once GitHub writes. A lost response can occur after a write. The guarantee is idempotent reconciliation for the same immutable publication identity under the documented state checks.

## Failure classification

| Classification | Examples | Retryable |
| --- | --- | --- |
| invalid | Unsupported contract version, malformed schema, unsafe path, digest mismatch, unsupported file type. | No |
| policy | Untrusted caller, repository not allowlisted, installation missing, permission denial. | No |
| conflict | Base moved, mismatched pre-existing branch, closed/merged or conflicting PR. | No; new authorization may be required. |
| retryable | GitHub rate limit, network timeout, 5xx, token endpoint unavailable, or reconciliation itself unavailable. | Yes, using same request after backoff. |
| internal | Unexpected Kirisame defect with no safe classification. | No by default; inspect redacted diagnostics. |

The API returns a bounded error code, classification, safe message, optional retryAfterSeconds and requestId. It never returns raw GitHub response bodies or secrets.

## Timeout and backoff proposal

Proposed initial integration defaults, to be confirmed during Phase 1/2 mock and load work: Soyuz gives one Service Binding attempt up to 120 seconds; each outbound GitHub request has a 15-second timeout. A transport timeout is an uncertain outcome, not a failed mutation. Soyuz retries the identical request after bounded exponential backoff with jitter, starting at 2 seconds and capped at 5 minutes. It honors GitHub Retry-After up to a one-hour delay and persists the next attempt time. After three immediate transient failures, it yields to the durable Soyuz scheduler rather than looping in one Worker invocation. These values are policy proposals, not implemented runtime behavior.

## Persistence decision

Do not add a Kirisame D1, KV, Queue or Durable Object journal initially. The initial Kirisame service has no stateful endpoint beyond GitHub, and a local journal cannot make a GitHub write transactional. Soyuz already owns canonical state and D1 compare-and-set transitions; GitHub refs and PRs are the publication side effects to reconcile.

This decision depends on a Soyuz publication record with unique publicationId, immutable request fingerprint, attempt lease/fencing value, next-attempt time, bounded event history, terminal result, and artifact-retention pin. Current Soyuz has run idempotency but no publication ledger, so the dependency is Proposed. If deployment evidence shows that Soyuz cannot serialize attempts or GitHub reads cannot establish operation identity, revisit a Kirisame journal with a specific consistency requirement before provisioning any storage.
