# ADR 0007: Idempotency and GitHub reconciliation

**Status:** Proposed

## Context

GitHub may complete a branch or PR mutation while the response is lost. Repeating a request without reading remote state can overwrite an unrelated branch or create a duplicate PR. Soyuz's existing run idempotency ledger does not define a publication operation.

## Decision

Use a stable Soyuz-generated publicationId and immutable request fingerprint. Derive the branch as kirisame/p/{publicationId}. Soyuz serializes attempts with a D1 compare-and-set. Kirisame uses create-only refs and reconciles branch and PR state before repeating mutations. A mismatched existing branch is a permanent conflict; never force update or delete it.

For PR mode, reconcile open and closed PRs by exact head, base and a Kirisame marker in the PR body. Return an existing matching open PR; a closed or unrelated PR blocks this publicationId.

## Alternatives considered

- Generate a new random branch for each attempt.
- Force-update a branch to the latest artifact.
- Treat request replay as exactly-once publication.
- Persist an independent Kirisame operation journal.

## Reasons

Deterministic refs and GitHub reads make ambiguous outcomes observable. Soyuz can reject same-ID/different-input requests before dispatch. Create-only branch refs avoid overwriting unrelated work, and the marker makes PR reconciliation attributable.

## Consequences and trade-offs

This is not an exactly-once guarantee. It requires the future Soyuz publication record, request fingerprint, attempt lease and artifact retention pin. Closed or conflicting PRs require a new authorization and publicationId. Concurrent duplicate calls still reconcile against GitHub rather than relying only on a lock.
