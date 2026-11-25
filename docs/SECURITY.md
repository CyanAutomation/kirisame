# Security policy

Kirisame is the GitHub write boundary. Phase 0.1 contracts, Phase 1.1 hardening, and Phase 2A GitHub App authentication and the real REST adapter are implemented. The last deployed release used a receiver-side Somatic allowlist and passed the live canary. The target RPC authenticates each service with its own Worker secret and removes Kirisame's repository allowlist. The current App installation selects all repositories and has the grants listed below; it does not currently narrow the caller's repository choice. Soyuz's authenticated binding source is merged with dispatch disabled; Kaseki's trusted producer still needs host rollout. Keep code defaults fail-closed.

## GitHub App identity and permissions

The intended machine identity is the existing Kirisame GitHub App owned by CyanAutomation, App ID 3345400. Use App JWT authentication only to obtain a short-lived installation access token. Do not use a personal access token or GitHub user OAuth. The OAuth Client ID is not used for this service-to-service flow.

| GitHub App repository permission | Level | Use |
| --- | --- | --- |
| Metadata | Read | Identify a repository and installation. GitHub requires metadata read access for repository operations. |
| Actions | Read | Existing grant accepted by the App owner; not requested by Kirisame's publication token. |
| Checks | Read and write | Existing grant accepted by the App owner; not requested by Kirisame's publication token. |
| Contents | Read and write | Read a base commit/tree; create blobs, trees and commits; create a publication branch. |
| Commit statuses | Read and write | Existing grant accepted by the App owner; not requested by Kirisame's publication token. |
| Pull requests | Read and write | Find, create and reconcile pull requests for PR mode. |

The GitHub Git Trees and Git Commits endpoints require Contents write; creating a pull request requires Pull requests write. Editing GitHub Actions workflow files requires a separate Workflows permission, which is outside v1. Kirisame must reject changes under .github/workflows rather than request that permission. Verify endpoint permissions against [GitHub's permission guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [Git Trees API](https://docs.github.com/en/rest/git/trees), [Git Commits API](https://docs.github.com/en/rest/git/commits), and [Pull Requests API](https://docs.github.com/en/rest/pulls/pulls).

Generate an installation token only after caller authentication and request validation. Request access to exactly the owner/repository in the request and only the permissions required for the selected mode. GitHub permits scoping installation tokens by repository and permission, and the token expires after one hour; see [installation access token guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app). Never return a token to Soyuz or executors.

The App private key belongs only in Kirisame's trusted Worker secret configuration. Do not place it on Kaseki or Rusty-Fossil hosts, in a Queue message, D1, R2, a source file, a fixture, or a log. The numeric App ID is not secret. Redact both GitHub JWTs and installation tokens from exceptions, HTTP traces and diagnostics. Do not log raw GitHub response bodies.

### GitHub App configuration review checklist

The GitHub App settings were reviewed on 2026-11-24. The App owner accepts the current all-repositories installation and the permissions listed above for the Phase 2A.2 commissioning; no GitHub App setting change is required for this canary.

- Confirm the App identity is Kirisame, owner CyanAutomation, App ID 3345400.
- Keep the current grants: Metadata read, Actions read, Checks read/write, Contents read/write, Commit statuses read/write, and Pull requests read/write.
- Keep the current installation selection of all repositories for this commissioning; the App owner has accepted it.
- Kirisame has no repository allowlist. The App's all-repositories installation currently does not narrow repository choice; if changed to selected repositories, that list is an additional capability ceiling.
- Require authenticated caller IDs and per-service API keys for every private publication/preflight RPC. Keep one secret per caller and never pass keys in canonical JSON.
- Request installation tokens for exactly the requested repository with only operation-specific permissions plus Metadata read.
- Do not add Workflows, Administration, secrets, deployments, or organization permissions.
- Do not configure a user OAuth flow or rely on the OAuth Client ID for machine authentication.
- Store the private key only as a Kirisame Worker secret; define a reviewed rotation and revocation procedure before production use.
- Confirm no webhook is required for v1. If a future webhook is added, define its signature verification and replay rules separately.
- The App Homepage URL currently points to the general CyanAutomation portfolio. A Kirisame repository or Worker URL would be more specific. This is descriptive metadata, not an OAuth callback requirement; do not change it as part of this implementation.

The runtime signs RS256 App JWTs with `iat` 60 seconds in the past and an expiry no more than 10 minutes after issue time. It accepts the configured App ID or optional Client ID as issuer, supports unencrypted PKCS#1 and PKCS#8 PEM keys, and does not log or persist the key. GitHub's requirements are in [JWT generation guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app).

## Caller authentication, caller policy, and App access

These are separate controls:

1. **Caller authentication:** the private RPC requires `(requestJson, callerId, apiKey)`. Kirisame checks the ID and secret against `KIRISAME_CALLER_KEYS` before parsing the request. Unknown or invalid credentials return `UNAUTHORIZED_CALLER` without GitHub work.
2. **Caller repository policy:** Kirisame has no repository allowlist. Each authenticated service is trusted to choose its own target. Soyuz applies `PUBLICATION_REPOSITORY_ALLOWLIST` against canonical run state, currently Somatic PRs to `main`; the live canary and local harness validate their fixed target.
3. **GitHub App access:** Kirisame resolves the installation for the exact requested repository, checks its identity, suspension and permissions, and requests a token scoped to that repository. The current installation selects all repositories, so it does not restrict repo choice. A selected-repository install would add an independent cap.

An API key identifies a service; it is not repository authorization. Never issue a key to a coding executor or a service that accepts arbitrary repository names without an authorization check. See [Private RPC authentication and repository policy](PRIVATE-RPC-AUTH.md).

## Request authentication and provenance

The intended production interface is a private Cloudflare Service Binding. The Worker exports a separate named typed-RPC publisher entrypoint; Soyuz source declares it with dispatch disabled. Do not expose a public publishing route, accept bearer credentials from executors, or trust identity headers supplied by an HTTP caller. The binding must stay on trusted callers only; the public default `fetch()` handler must never dispatch to publication logic.

Soyuz must load canonical run state and trusted validation evidence, resolve the requested mode and destination, and authorize one stable publicationId before calling Kirisame. Kirisame verifies that artifact runId, repository, baseRef and baseSha equal the request, and verifies artifactDigest and all file hashes. A caller-supplied validationPassed boolean is never sufficient evidence. Soyuz's ledger, claim-fenced artifacts and intents are implemented; the trusted Kaseki host still needs rollout.

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
- Reject .git metadata paths and unsupported path/mode types as defined in [Artifacts](ARTIFACTS.md). Reject artifact changes to any `.gitattributes` file, reject changed files governed by an LFS filter in the pinned base tree, and fail closed on unsupported attribute patterns or active filters.
- Treat GitHub 401/403 permission failures as policy/configuration failures. Do not retry them as network failures. Handle rate limits and transient 5xx responses under the bounded rules in [Lifecycle](LIFECYCLE.md).

GitHub's Update a Reference API defaults to non-force updates and rejects conflicts; v1 uses create-only branch references and does not request force behavior. See [Git references](https://docs.github.com/en/rest/git/refs). Direct writes to protected branches are outside the contract.

## Pull request and retry safety

Before creating a pull request, list PRs for the exact repository, head and base. A PR body includes a machine-readable Kirisame marker containing publicationId, runId, artifactDigest and a digest of the full immutable request, including mode, title and body. Existing PR reconciliation checks exact repository identities, head/base refs, title and body as well as the marker. If one matching open PR exists, return it. If the matching PR is closed or merged, or more than one conflicting PR exists, return a structured conflict; do not reopen, create a duplicate, or change unrelated PR metadata.

Never treat a timeout as proof that a GitHub mutation failed. Re-read refs and PRs first. A branch whose commit or marker does not match the request is a permanent conflict. A retryable result may include a confirmed branch without a PR so Soyuz can retry the same publication identity after backoff.

## Audit, response and diagnostics

Soyuz owns the durable append-only publication event history. Each attempt records publicationId, runId, repository, mode, base/head refs, artifact digest, state transition, timestamp, a safe error code, and GitHub branch/PR identifiers when present. Kirisame returns bounded structured results and safe messages only. Do not persist or return private keys, installation tokens, full API response bodies, prompts, artifact contents, local paths, or raw executor logs.

The publication result and lifecycle event schemas reject unknown fields. Unexpected failures map to INTERNAL_ERROR with a request ID; internal exception detail remains in access-controlled, redacted diagnostics and must not include credentials.
