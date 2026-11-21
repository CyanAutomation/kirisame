# Security policy

Kirisame is intended to be the GitHub write boundary. Phase 0.1 hardens the v1 contract, and Phase 1 adds a mock-driven publication runtime and diagnostics-only Worker. Production GitHub publishing is disabled: no GitHub App credentials, installation configuration, real GitHub adapter, or Soyuz Service Binding are present. The named production publisher returns the structured `PUBLISHING_UNAVAILABLE` error for valid requests.

## GitHub App identity and permissions

The intended machine identity is the existing Kirisame GitHub App owned by CyanAutomation, App ID 3345400. Use App JWT authentication only to obtain a short-lived installation access token. Do not use a personal access token or GitHub user OAuth. The OAuth Client ID is not used for this service-to-service flow.

| GitHub App repository permission | Level | Use |
| --- | --- | --- |
| Metadata | Read | Identify a repository and installation. GitHub requires metadata read access for repository operations. |
| Contents | Read and write | Read a base commit/tree; create blobs, trees and commits; create a publication branch. |
| Pull requests | Read and write | Find, create and reconcile pull requests for PR mode. |

The GitHub Git Trees and Git Commits endpoints require Contents write; creating a pull request requires Pull requests write. Editing GitHub Actions workflow files requires a separate Workflows permission, which is outside v1. Kirisame must reject changes under .github/workflows rather than request that permission. Verify endpoint permissions against [GitHub's permission guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [Git Trees API](https://docs.github.com/en/rest/git/trees), [Git Commits API](https://docs.github.com/en/rest/git/commits), and [Pull Requests API](https://docs.github.com/en/rest/pulls/pulls).

Generate an installation token only after repository policy checks. Request access to exactly the owner/repository being published and only the permissions required for the selected mode. GitHub permits scoping installation tokens by repository and permission, and the token expires after one hour; see [installation access token guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app). Never return a token to Soyuz or executors.

The App private key belongs only in Kirisame's trusted Worker secret configuration. Do not place it on Kaseki or Rusty-Fossil hosts, in a Queue message, D1, R2, a source file, a fixture, or a log. The numeric App ID is not secret. Redact both GitHub JWTs and installation tokens from exceptions, HTTP traces and diagnostics. Do not log raw GitHub response bodies.

### GitHub App configuration review checklist

This remains a future review checklist. No GitHub App setting or credential is configured by the Phase 0.1/Phase 1 foundation.

- Confirm the App identity is Kirisame, owner CyanAutomation, App ID 3345400.
- Set only Metadata read, Contents read/write, and Pull requests read/write.
- Leave Workflows, Administration, Actions, secrets, checks, deployments, and organization permissions unset.
- Configure installation access for selected repositories only; do not install on all repositories by default.
- Review each installation's repository selection against the Kirisame repository allowlist.
- Do not configure a user OAuth flow or rely on the OAuth Client ID for machine authentication.
- Store the private key only as a Kirisame Worker secret; define a reviewed rotation and revocation procedure before production use.
- Confirm no webhook is required for v1. If a future webhook is added, define its signature verification and replay rules separately.

## Two independent repository gates

A repository is publishable only when both conditions hold:

1. The GitHub App installation has access to that repository.
2. Kirisame's own explicit allowlist authorizes that exact lower-case owner/name and the requested branch/PR operation.

Installation does not imply Kirisame policy authorization. Kirisame does not infer permission from a request's repository field, from a caller-selected installation ID, or from the presence of a working token. Resolve the installation from the configured App and exact repository after allowlist validation.

## Request authentication and provenance

The intended production interface is a private Cloudflare Service Binding called only by Soyuz. The Worker exports a separate named typed-RPC publisher entrypoint, but no production binding is currently configured. Do not expose a public publishing route, accept bearer credentials from executors, or trust identity headers supplied by an HTTP caller. When configured, deployment must attach the binding only to Soyuz; the public default `fetch()` handler must never dispatch to publication logic.

Soyuz must load canonical run state and trusted validation evidence, resolve the requested mode, and authorize one stable publicationId before calling Kirisame. Kirisame verifies that the artifact's runId, repository, baseRef and baseSha equal the request, verifies artifactDigest and all file hashes, and applies its independent allowlist. A caller-supplied validationPassed boolean is never sufficient evidence. Current Soyuz callbacks are claim-fenced but do not contain an immutable file-change manifest or a publication authorization record; those remain integration prerequisites.

## Branch and repository operation policy

- Accept only explicit branch or pr operations. Soyuz resolves auto and none before the call.
- Treat pr as the default across publication entry points. Branch-only publication is a rare explicit test exception; none is resolved in Soyuz and never sent to Kirisame.
- Use only the deterministic head ref kirisame/p/{publicationId}. Reject any other head ref.
- Never write or merge the base/default branch. Never create, edit, delete or change repository settings.
- Read the deterministic publication ref before the current target base ref. Return an already-confirmed matching branch/PR after target movement; require the remote base to equal baseSha before new writes or before creating a missing PR. Do not silently rebase on a changed target.
- Create a branch ref only when it is absent. If it exists, reuse it only after proving it represents the same publicationId, runId, baseSha and artifactDigest. Otherwise return BRANCH_CONFLICT.
- Never force-update, delete or overwrite a pre-existing branch. Use GitHub ref updates only with force disabled if a future operation explicitly requires an update; v1 does not update an existing ref.
- Let repository rules and branch protections reject the operation. Do not bypass protections or request bypass permissions. A protected publication branch may produce a policy rejection.
- Do not merge pull requests, invoke repository scripts, execute Git commands, or expose a generic GitHub API proxy.
- Reject .git metadata paths and unsupported path/mode types as defined in [Artifacts](ARTIFACTS.md).
- Treat GitHub 401/403 permission failures as policy/configuration failures. Do not retry them as network failures. Handle rate limits and transient 5xx responses under the bounded rules in [Lifecycle](LIFECYCLE.md).

GitHub's Update a Reference API defaults to non-force updates and rejects conflicts; v1 uses create-only branch references and does not request force behavior. See [Git references](https://docs.github.com/en/rest/git/refs). Direct writes to protected branches are outside the contract.

## Pull request and retry safety

Before creating a pull request, list PRs for the exact repository, head and base. A PR body includes a machine-readable Kirisame marker containing publicationId, runId and artifactDigest so a lost create response can be reconciled. If one matching open PR exists, return it. If the matching PR is closed or merged, or more than one conflicting PR exists, return a structured conflict; do not reopen, create a duplicate, or change unrelated PR metadata.

Never treat a timeout as proof that a GitHub mutation failed. Re-read refs and PRs first. A branch whose commit or marker does not match the request is a permanent conflict. A retryable result may include a confirmed branch without a PR so Soyuz can retry the same publication identity after backoff.

## Audit, response and diagnostics

Soyuz owns the durable append-only publication event history. Each attempt records publicationId, runId, repository, mode, base/head refs, artifact digest, state transition, timestamp, a safe error code, and GitHub branch/PR identifiers when present. Kirisame returns bounded structured results and safe messages only. Do not persist or return private keys, installation tokens, full API response bodies, prompts, artifact contents, local paths, or raw executor logs.

The publication result and lifecycle event schemas reject unknown fields. Unexpected failures map to INTERNAL_ERROR with a request ID; internal exception detail remains in access-controlled, redacted diagnostics and must not include credentials.
