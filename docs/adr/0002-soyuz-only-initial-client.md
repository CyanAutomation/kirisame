# ADR 0002: Soyuz is the only initial authorized client

**Status:** Accepted

## Context

Kirisame publishes changes only after a trusted orchestration service has established that the run and artifact are eligible. Kaseki-Agent and Rusty-Fossil are executors, not publication authorities.

## Decision

Only Soyuz may call the initial publication interface. Use a private Service Binding configured only on Soyuz. Do not expose a public endpoint or accept direct executor requests.

## Alternatives considered

- Give each executor its own binding or credentials.
- Let coding agents call Kirisame directly.
- Permit arbitrary future services to invoke the publisher.

## Reasons

Soyuz owns canonical run identity and authorization. A single initial caller keeps the trust boundary reviewable and prevents a successful code-generation job from granting GitHub write authority.

## Consequences and trade-offs

Soyuz must persist publication authorization and issue one stable publicationId. Additional callers require a separately reviewed identity and authorization model. When introduced, the Service Binding must be configured only on Soyuz; a public route would require a new authentication design. The Phase 1 Worker exports a separate named publisher entrypoint, but its production configuration has no binding and no connected caller.
