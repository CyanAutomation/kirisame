# ADR 0008: Default all normal publication requests to pull requests

**Status:** Accepted

## Context

The regular Soyuz REST route and Kaseki's controller already default to `pr`, but Soyuz agent/UTCP inputs default to `none` and Kaseki's CLI configuration falls back to `auto`. `auto` may silently skip publication when credentials are absent. The different entry-point behavior makes a run's publication outcome depend on how it was submitted.

## Decision

Use `publishMode: "pr"` as the default for normal submissions in Soyuz, Kaseki, Rusty-Fossil and caller guidance for Kirisame. Keep Kirisame's operation field required and explicit; its schema annotates `pr` as the client default. Other modes remain available only as explicit, narrowly scoped exceptions, primarily for tests. Soyuz resolves `none` without calling Kirisame.

## Alternatives considered

- Keep entry-point-specific defaults (`pr`, `none`, `auto`).
- Remove `none`, `branch`, and `auto` from all schemas.
- Make Kirisame infer a missing operation.

## Reasons

One default makes publication behavior predictable across REST, agent, CLI and queue paths. `pr` preserves the intended review workflow and makes missing GitHub credentials visible as an admission failure instead of silently skipping. Keeping explicit exceptions supports tests without making them routine behavior. Requiring an operation at Kirisame preserves its fail-closed trust boundary.

## Consequences and trade-offs

Normal code runs may create pull requests and therefore require ready GitHub credentials. Test and dry-run configurations must explicitly use the appropriate exception and a non-production target. Existing saved configuration that explicitly sets `auto` must be reviewed during rollout; omission now means `pr`. Companion implementation changes are tracked in the Soyuz, Kaseki-Agent and Rusty-Fossil policy updates.
