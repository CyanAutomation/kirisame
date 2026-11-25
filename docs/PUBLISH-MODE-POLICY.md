# Default publish mode policy

## Rule

The system default is `publishMode: "pr"` for every ordinary run, from admission through execution and publication. A missing value must resolve to `pr`. Do not configure a normal deployment to use `auto`, `none`, or `branch`, and do not use those modes to hide missing GitHub credentials or avoid the normal review path.

This default gives automated submissions a real publication effect: after authorization and validation, a normal run can create a branch and open a pull request. Callers must account for that effect when admitting work, selecting an authorized destination repository, and retaining the artifact. Kirisame has no repository allowlist; Soyuz validates its destination from canonical run state and its own repository policy before the private RPC. An open PR is a review request, not approval or merge authorization. GitHub branch protection, CODEOWNERS and required checks remain the repository's review controls. Kirisame does not merge PRs. Missing Kirisame `mode` is rejected at runtime; the schema's `default: "pr"` documents caller policy and is never applied by validation.

| Component | Default behavior | Exception boundary |
| --- | --- | --- |
| Soyuz REST, agent and UTCP entry points | Resolve an omitted mode to `pr` before persisting and queueing the run. | Preserve an explicit non-`pr` mode only for an authorized, narrowly scoped test. |
| Kaseki API, CLI, worker and built-in configuration | Resolve omissions and fallback configuration to `pr`; fail admission when required GitHub credentials are unavailable. | `auto`, `none`, or `branch` must be an explicit temporary test setting. Never use `auto` as a deployment default because it can silently skip publishing. |
| Rusty-Fossil queue contract | Preserve Soyuz's normalized mode; its compatibility default for an omitted field is `pr`. | Do not rewrite a non-`pr` value. It may pass only through an explicitly authorized test request. |
| Kirisame | The request schema documents `pr` as the default for callers. `mode` remains required and accepts only explicit `pr` or `branch`. | `branch` is reserved for a test that specifically needs branch-only publication. Soyuz handles `none` without calling Kirisame. |

## Allowed exceptions

An exception must be explicit in the test request or test-only configuration, scoped to a disposable repository or local/non-production environment, and removed when the test ends. Use:

- `none` for admission, validation, or execution tests that must not write to GitHub.
- `branch` only to verify branch-only behavior without opening a pull request.
- `auto` only to test legacy credential-presence behavior; ordinary runs must use `pr` and fail visibly if credentials are unavailable.

Do not carry an exception into a shared production default, saved normal-run profile, or routine operator workflow. If a production operation needs a different mode, require explicit authorization and document the reason before dispatch.

## Compatibility and rollout

Soyuz resolves its normal default before writing the canonical request and Queue message. Executors preserve that value; they do not add their own `auto` or `none` fallback. Kirisame rejects a missing mode at its private boundary, even though the schema records `pr` as the caller default, so an incomplete trusted request fails closed. Roll out default changes in Soyuz and Kaseki together, then update any existing saved CLI configuration that explicitly sets `auto`.

This policy does not change the supported contract enums, the existing execution terminal states, or test coverage that deliberately exercises non-default modes.
