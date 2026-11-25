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

For every request, validate its contract, artifact provenance, canonical digest, file contents and repository policy before GitHub mutations. Reconciliation then follows the publication ref first:

1. Read the deterministic head ref `kirisame/p/{publicationId}` before resolving the current target base ref.
2. If the head ref exists, read its commit and tree. Reuse it only when its parent is the requested `baseSha`, its commit marker identifies the same publicationId/runId/artifactDigest and complete request digest, and its full tree matches the expected artifact. Otherwise return `BRANCH_CONFLICT` without modifying the ref.
3. For `branch` mode, return `branch_published` after confirming that matching commit.
4. For `pr` mode, list PRs for the exact repository, head and base, including closed PRs. Return a matching open PR as confirmed success even if the target branch has since advanced. A closed, merged, duplicate or mismatched PR is `PULL_REQUEST_CONFLICT`.
5. If a matching branch exists but no PR exists, read the target base ref. Create the PR only if it still equals the requested `baseSha`; otherwise return `BASE_MOVED`, preserving the branch as partial progress.
6. If the publication branch does not exist, resolve the target base ref and require it to equal `baseSha` before writing any Git object. Do not rebase or silently produce a different commit.
7. Read the pinned base tree and check every add/modify/delete precondition. Create content-addressed blobs, the tree and a one-parent commit whose parent is `baseSha`. Create the deterministic ref only if absent, then read it back and verify its commit and full tree.
8. In `pr` mode, list PRs for the exact head/base before creating one. If the create response is ambiguous, list again and return the matching open PR if present.
9. If a GitHub read needed for reconciliation fails, return `retryable_failure` with reconciliation unknown and a safe retry delay. A later retry must read remote state before repeating an uncertain write.

The ordering matters: once the deterministic branch and matching open PR prove that this publication completed, later movement of the target branch does not invalidate that result. Base equality is required before new branch writes and before completing an existing branch whose PR is still missing. The implementation does not silently rebase, force-update refs or claim exactly-once writes.

The GitHub REST Git Data API can create blobs, trees, commits and refs. Git Data commit responses are parsed from top-level `sha`, `tree`, `parents` and `message` fields; the separate repository Commits API's nested `commit` object is rejected. Ref creation is deliberately create-only; updates are not used in v1. Pull requests are separately created and reconciled using repository identities, head, base, and the exact Kirisame publication marker. Reviewers may change the title and descriptive body while preserving that marker; Kirisame returns the open PR without overwriting human edits. The real adapter reads trees recursively by fetching each subtree and rejects truncation, bounds traversal to 50,000 entries and depth 64, paginates PR reads (up to 20 pages), verifies blob bytes against Git object SHA-1, and bounds API responses. See [Git trees](https://docs.github.com/en/rest/git/trees), [Git commits](https://docs.github.com/en/rest/git/commits), [Git references](https://docs.github.com/en/rest/git/refs), and [Pull Requests](https://docs.github.com/en/rest/pulls/pulls).

## Required retry cases

| Situation | Required behavior |
| --- | --- |
| First request | Validate before mutation, check the deterministic ref, pin baseSha before new writes, create content objects and ref, then create/reconcile a PR. |
| Identical replay | Re-read GitHub state and return the matching branch/PR. Do not create another ref or PR. |
| Same publicationId with different content or metadata | Soyuz rejects by stored fingerprint. If Kirisame observes a ref/PR marker mismatch, return a permanent conflict. |
| Branch created, PR not created | Confirm the branch commit and marker; if the target base still equals baseSha, create the PR after a confirmed absence check. Otherwise retain the branch and return BASE_MOVED. |
| PR created, response lost | Re-list by exact head/base and publication marker; return the existing PR. |
| Temporary token-service or connectivity failure | Classify as retryable only for timeout, network failure or service 5xx. Reconcile after any ambiguous mutation. A confirmed bad permission is blocked. |
| GitHub rate limiting | Return retryable with Retry-After when present. Soyuz waits; Kirisame does not busy-loop or exceed bounded attempts. |
| Base branch moves | An already-complete matching branch/PR remains confirmed success. Before new branch writes or PR completion, return BASE_MOVED if the target no longer equals baseSha. Preserve any existing branch; do not rebase. A changed base/artifact requires new authorization and publicationId. |
| Pre-existing conflicting feature branch | Reuse only if marker, parent/base SHA and commit content all match. Otherwise return BRANCH_CONFLICT without modifying it. |
| Concurrent calls for one publicationId | Soyuz compare-and-set allows one active dispatcher. If a duplicate still reaches Kirisame, the deterministic ref create conflicts safely and it reconciles; GitHub PR uniqueness plus the marker prevents duplicate PRs. |

Do not claim exactly-once GitHub writes. A lost response can occur after a write. The guarantee is idempotent reconciliation for the same immutable publication identity under the documented state checks.

## Failure classification

| Classification | Examples | Retryable |
| --- | --- | --- |
| invalid | Unsupported contract version, malformed schema, unsafe path, digest mismatch, unsupported file type. | No |
| policy | Invalid private caller key, missing GitHub App installation, insufficient App permission, or another authorization failure. | No; correct the configuration and reauthorize explicitly. |
| conflict | Base moved, mismatched pre-existing branch, closed/merged or conflicting PR, or `NO_CHANGES` because the normalized artifact leaves the pinned tree unchanged. | No; a changed artifact requires new authorization and a new publication ID. |
| retryable | GitHub rate limit, network timeout, 5xx, token endpoint unavailable, or reconciliation itself unavailable. | Yes, using same request after backoff. |
| internal | Unexpected Kirisame defect with no safe classification. | No by default; inspect redacted diagnostics. |

The API returns a bounded error code, classification, safe message, optional retryAfterSeconds and requestId. It never returns raw GitHub response bodies or secrets.

## Timeout and backoff proposal

The real adapter uses a 10-second per-request timeout by default; the configured range is 100 ms to 30 seconds. A transport timeout is an uncertain outcome, not a failed mutation. Soyuz integration defaults still need review: one Service Binding attempt up to 120 seconds; durable retries of the identical request after bounded exponential backoff with jitter, starting at 2 seconds and capped at 5 minutes; honor GitHub Retry-After up to a one-hour delay; and yield after three immediate transient failures. These remain Soyuz policy proposals, not implemented scheduling behavior in Kirisame.

## Persistence decision

Do not add a Kirisame D1, KV, Queue or Durable Object journal initially. The initial Kirisame service has no stateful endpoint beyond GitHub, and a local journal cannot make a GitHub write transactional. Soyuz already owns canonical state and D1 compare-and-set transitions; GitHub refs and PRs are the publication side effects to reconcile.

Soyuz implements this publication record in D1 with a unique publicationId, immutable request fingerprint, attempt lease/fencing value, next-attempt time, bounded event history, terminal result, and artifact-retention pin. Production migration `0009` is applied. Keep this state in Soyuz; do not add a second journal or Durable Object to Kirisame. Revisit the decision only if evidence shows Soyuz cannot serialize attempts or GitHub reads cannot establish operation identity.
