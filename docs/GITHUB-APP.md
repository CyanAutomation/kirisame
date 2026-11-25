# GitHub App setup and operations

## Current state

Kirisame uses the existing CyanAutomation GitHub App, App ID `3345400`. The code implements App JWT signing, installation resolution, repository-scoped token issuance, and the GitHub Git Data and Pull Requests APIs. The production Worker has the existing App key as a Cloudflare secret binding, and the App is installed on `CyanAutomation/somatic`. The installation currently selects all repositories. The App owner has accepted that scope and the App's current permission levels for this commissioning; no GitHub setting change is required. Production publishing is enabled only for Somatic PRs to `main`; the private canary created PR #128 and an identical replay reused it. The Soyuz private binding and trusted Kaseki producer are not connected yet. The private key value is not stored in this repository.

The App Homepage URL currently points to a general CyanAutomation portfolio page. A link to the Kirisame repository or Worker would describe the integration more clearly. The Homepage URL is descriptive metadata; it is not an OAuth callback URL. Do not change App settings as part of implementation work.

## App identity and permissions

Use only the existing Kirisame App owned by CyanAutomation. Do not create another App or use a personal access token or GitHub user OAuth.

Configure these repository permissions on the App:

| Permission | Current App access | Runtime use |
| --- | --- | --- |
| Metadata | Read-only | Resolve repository and installation identity. |
| Actions | Read-only | Existing App grant; not requested by Kirisame's publication token. |
| Checks | Read and write | Existing App grant; not requested by Kirisame's publication token. |
| Contents | Read and write | Read base objects and write blobs, trees, commits, and publication refs. |
| Commit statuses | Read and write | Existing App grant; not requested by Kirisame's publication token. |
| Pull requests | Read and write | List, create, and reconcile PRs in PR mode. |

The App owner accepts the existing Actions read, Checks read/write, and Commit statuses read/write grants for this commissioning. Kirisame still requests and verifies an installation token scoped to the exact target repository and only the permissions needed for the selected operation, plus Metadata read. Do not add Workflows, Administration, secrets, deployments, or organization permissions. Workflow files and changes to `.gitattributes` are rejected by Kirisame.

The current App installation selects all repositories. The App owner has explicitly accepted this scope for the current commissioning, so do not block this canary on repository selection and do not change the installation scope. The installation scope and Kirisame's own allowlist are separate gates: the allowlist must remain exact for `CyanAutomation/somatic`, and the runtime must request a token for that repository only.

## Private key and Worker configuration

Generate a private key only during an approved commissioning or rotation. Download it through the GitHub App settings page and place it directly into an approved secret manager; do not store it in a repository, local project `.env`, test fixture, ticket, shell history, or chat. Kirisame accepts unencrypted RSA PKCS#1 (`RSA PRIVATE KEY`) and PKCS#8 (`PRIVATE KEY`) PEM encodings. Encrypted PEM keys are not supported.

In the Cloudflare dashboard, open the selected Kirisame Worker, go to **Settings → Variables and Secrets**, and add `GITHUB_APP_PRIVATE_KEY` as a secret. Set non-secret configuration as text bindings:

- `GITHUB_APP_ID`: `3345400`
- `GITHUB_APP_CLIENT_ID`: optional; if set, it is used as the JWT issuer instead of the App ID
- `GITHUB_REPOSITORY_ALLOWLIST`: JSON array described below
- `PUBLISHING_ENABLED`: keep `false` until the private caller and canary configuration are reviewed

The allowlist is exact JSON. Each entry must contain only `owner`, `repository`, `operations`, and `baseBranches`. For an approved disposable test repository, its shape is:

```json
[
  {
    "owner": "ExampleOrg",
    "repository": "kirisame-canary",
    "operations": ["branch", "pr"],
    "baseBranches": ["main"]
  }
]
```

Use the actual approved repository name when one has been explicitly selected. Do not use wildcards. Empty, malformed, or unknown-field configuration fails closed. Keep production's default empty allowlist until its separate commissioning review.

The App ID and Client ID are not secrets. Never print or log the private key, App JWT, installation token, or `Authorization` header. Do not put token material in a deployment variable, request, result, D1, KV, R2, or Queue message.

## Authentication and token checks

For an authorized request, Kirisame first applies the repository/mode/base-branch allowlist. It then resolves the App installation for that repository, checks the App ID, repository owner, suspension state, and required permission levels, and requests an installation token scoped to exactly that repository. Branch mode asks for Contents write; PR mode additionally asks for Pull requests write. The response must name exactly that repository, contain no permissions beyond the requested set plus Metadata read, and expire in the future. The adapter retains the token only for that request-local instance.

Git Data API commit objects use the documented top-level response fields (`sha`, `tree`, `parents`, and `message`). The repository Commits API's nested `commit` response shape is not accepted at the Git Data endpoint. Tree reads use the documented `truncated` and tree-entry fields, fetch each subtree separately, and reject truncated results. See [Get a Git commit](https://docs.github.com/en/rest/git/commits#get-a-commit) and [Get a tree](https://docs.github.com/en/rest/git/trees#get-a-tree).

The App JWT uses RS256, sets `iat` 60 seconds in the past, and expires within GitHub's 10-minute maximum. The optional Client ID can be used as the issuer; otherwise the App ID is used. See GitHub's [JWT guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) and [installation token guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

Normal CI exercises signing and HTTP behavior using ephemeral keys and mocked GitHub responses. It does not need Cloudflare or GitHub credentials. A successful build or mock test does not prove the live App installation is usable.

## Initial commissioning procedure

The original Kirisame-only commissioning completed successfully as recorded in [Operations](OPERATIONS.md). Its temporary setup and cleanup steps below are historical; current production state is documented at the top of this page and in Operations. A new Soyuz-to-Kirisame end-to-end canary still requires the trusted Kaseki producer and Soyuz's private binding.

The approved Phase 2A.2 target is `CyanAutomation/somatic` with base branch `main`. Do not infer or substitute another repository or branch. Do not use production Soyuz to start the test.

1. Confirm the approved repository and base branch, and verify the Kirisame App installation and current owner-approved permissions. The current all-repositories installation and extra Actions/Checks/Commit statuses grants are accepted for this commissioning; no scope or permission change is required.
2. Use the existing `kirisame` Worker and its existing Cloudflare private-key secret. Do not deploy `kirisame-canary` as a publisher or copy credentials into the harness.
3. Use the deployed private Workflow invoker `kirisame-live-invoker`. It has no workers.dev or preview URL, no triggers, and only a `KIRISAME` Service Binding to `kirisame.PublisherEntrypoint`. Invoke its `preflight` action and require `{ status: "verified", repository: "CyanAutomation/somatic" }` before enabling publication.
4. Temporarily set the Worker's publishing flag and exact single-repository/base-branch PR allowlist through Cloudflare only after the positive preflight and public-route isolation are verified. Use the invoker's `allowlist-probe` action and require `confirmed-denial` for its fixed non-allowlisted target. Prepare one valid v1 PR request and invoke the `publish` action; the Workflow replays the identical JSON only after the first response confirms the matching open PR.
5. Independently confirm the branch, commit parent/tree, App author identity, PR head/base/marker, and that replay returned the same branch, commit and PR without another mutation.
6. Verify an unauthorized repository is denied before authentication or mutation, the public production publishing route remains inaccessible, and diagnostics contain no credentials or file contents.
7. Immediately restore `PUBLISHING_ENABLED=false` and `GITHUB_REPOSITORY_ALLOWLIST=[]`, verify the Cloudflare settings and public diagnostics, then record the sanitized GitHub and Cloudflare evidence. Leave the test PR open.

Do not run the canary unless the private preflight verifies the repository-scoped token behavior, the private binding is correct, and safe rollback is available. The App owner's accepted installation scope and permission levels above are not blockers. Do not broaden Kirisame's allowlist or copy credentials into another service to get around a missing prerequisite.

## Troubleshooting

| Safe error | Likely cause and response |
| --- | --- |
| `PUBLISHING_UNAVAILABLE` | Publishing is disabled or required configuration is absent/invalid. Confirm environment and keep the commissioning gate closed until reviewed. |
| `REPOSITORY_NOT_ALLOWED` | The exact owner/repository is not in the Kirisame allowlist. Verify the approved spelling and JSON policy. |
| `APP_NOT_INSTALLED` | The App is not installed on that repository, is suspended, or the returned repository identity does not match. Review installation selection. |
| `GITHUB_PERMISSION_DENIED` | The installation/App lacks a permission required for the selected operation. Grant only the missing repository permission after review. |
| `GITHUB_AUTH_INVALID` | GitHub rejected the App JWT or returned an invalid token scope/expiry. Verify that the Cloudflare secret is an active private key for this App without exposing the key; rotate only through the approved process if it is revoked. Never expose token values in diagnostics. |
| `GITHUB_RATE_LIMITED` | GitHub returned a rate limit. Honor `Retry-After` and let Soyuz's future durable scheduler retry the same immutable request. |
| `GITHUB_TIMEOUT` or `GITHUB_UNAVAILABLE` | The response was transient or uncertain. Reconcile GitHub state before retrying; do not assume a timed-out mutation failed. |

The Worker deliberately does not return raw GitHub response bodies. Use Cloudflare's access-controlled logs and GitHub's App/installation settings to diagnose the safe error category.

## Rotation, revocation, and rollback

To rotate a key, generate a replacement through GitHub's App settings, store it directly as the Cloudflare Worker secret, deploy/update the isolated target, verify a private canary, then revoke the old key after the rollout is confirmed. If the key is suspected compromised, revoke it immediately, keep `PUBLISHING_ENABLED=false`, and investigate access using GitHub and Cloudflare audit records. Never copy old or new key bytes into logs or an issue.

To revoke repository access, remove that repository from the App installation selection and from the Kirisame allowlist. To disable all publishing, set `PUBLISHING_ENABLED=false` or clear the allowlist, then verify `/readyz` reports `503` and the private publisher returns `PUBLISHING_UNAVAILABLE`.

Use the rollback process in [Operations](OPERATIONS.md) for Worker versions. After rollback, verify public diagnostics, the disabled publishing state, and any Service Binding configuration. Do not roll back to a version that can expose a public publishing route.

## Requirements for the Soyuz integration

Soyuz owns the durable publication ledger, claim checks, attempt fencing, event history, retry handling, and manifest retention. Migration `0009_durable_publications.sql` is present and applied in production. Kaseki's trusted producer and the Soyuz private binding are implemented in source; the producer host rollout and binding deployment remain pending, with dispatch explicitly off. The remaining release gates are host preflight, verification of the exact Somatic PR-to-`main` allowlist, and a new end-to-end canary with the legacy publisher disabled for that run. Keep publication state in Soyuz; Kirisame does not need a second journal or Durable Object. See [Soyuz integration](SOYUZ-INTEGRATION.md) and [Phase status](PHASE1-PLAN.md).
