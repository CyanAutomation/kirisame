# ADR 0007: Idempotency and GitHub reconciliation

**Status:** Accepted

## Context

GitHub may complete a branch or PR mutation while the response is lost. Repeating a request without reading remote state can overwrite an unrelated branch or create a duplicate PR. Soyuz's existing run idempotency ledger does not define a publication operation.

## Decision

Use a stable Soyuz-generated publicationId and immutable request fingerprint. Derive the branch as kirisame/p/{publicationId}. Soyuz should serialize attempts with a D1 compare-and-set. Kirisame validates the immutable request and policy, then reads the deterministic branch before reading the current target base ref. A matching branch is reused only after verifying its commit marker, base parent and complete expected tree. A mismatched existing branch is a permanent conflict; never force update or delete it.

For PR mode, reconcile open and closed PRs by exact repository identities, head, base, and a Kirisame marker in the PR body. The marker binds publicationId, runId, artifactDigest, and a digest of the complete immutable request. The marker is the authority for the original request's title and description; reviewers may edit surrounding title and body text while preserving the marker. Reconciliation never overwrites those edits. A missing, altered, duplicated, or mismatched marker conflicts. Return an existing matching open PR as success even when the base ref has advanced. If the branch exists but no PR exists, require the target base to still match the requested baseSha before creating the PR. If the branch does not exist, require base equality before writing Git objects or creating the branch. A closed or unrelated PR blocks this publicationId. Reject a normalized no-op before creating any Git object.

## Alternatives considered

- Generate a new random branch for each attempt.
- Force-update a branch to the latest artifact.
- Treat request replay as exactly-once publication.
- Persist an independent Kirisame operation journal.

## Reasons

Deterministic refs and GitHub reads make ambiguous outcomes observable. Soyuz can reject same-ID/different-input requests before dispatch. Create-only branch refs avoid overwriting unrelated work, and the marker makes PR reconciliation attributable.

## Consequences and trade-offs

This is not an exactly-once guarantee. It requires the future Soyuz publication record, request fingerprint, attempt lease and artifact retention pin. Closed or conflicting PRs require a new authorization and publicationId. Concurrent duplicate calls still reconcile against GitHub rather than relying only on a lock. The real adapter and HTTP-backed service tests implement and exercise these rules; the Soyuz ledger and live GitHub canary remain prerequisites to production activation.
