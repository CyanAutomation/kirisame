# ADR 0005: Soyuz owns publication lifecycle state

**Status:** Proposed

## Context

Kirisame must recover branch creation, PR creation and lost responses. Soyuz already owns canonical run state and D1, but it currently has no separate publication record. A completed run's callback may include publishedUrl; Kaseki performs publication before that callback.

## Decision

Keep publication lifecycle and durable attempt history in Soyuz. Add a future publication record keyed by publicationId, with immutable request fingerprint, CAS dispatch lease, state, next-attempt time, artifact retention pin, safe result and append-only events. Do not create a Kirisame journal or add Kirisame D1, KV, Queue or Durable Object for the initial design.

## Alternatives considered

- Make Kirisame's own database canonical for publication state.
- Rely only on a synchronous service response and the executor's completion callback.
- Add durable workflow infrastructure before a demonstrated need.

## Reasons

Soyuz is the canonical control plane and already has durable D1 state. GitHub remains the external state that Kirisame reads to reconcile ambiguous mutations. A second canonical state store would add distributed consistency without making GitHub writes transactional.

## Consequences and trade-offs

The recommendation depends on a new Soyuz publication record and its compare-and-set serialization. Current run idempotency alone is insufficient. If recovery or concurrency testing shows GitHub state plus Soyuz records cannot prove operation identity, revisit a Kirisame journal with an explicit consistency requirement.
