# GitHub App setup and operations

## Current state

Kirisame uses the existing CyanAutomation GitHub App, App ID `3345400`. The code implements App JWT signing, installation resolution, repository-scoped token issuance, and the GitHub Git Data and Pull Requests APIs. No App key, installation, repository allowlist entry, live canary, or Soyuz Service Binding is configured by this change. The checked-in Worker configuration sets `PUBLISHING_ENABLED=false` and `GITHUB_REPOSITORY_ALLOWLIST=[]`.

The App Homepage URL currently points to a general CyanAutomation portfolio page. A link to the Kirisame repository or Worker would describe the integration more clearly. The Homepage URL is descriptive metadata; it is not an OAuth callback URL. Do not change App settings as part of implementation work.

## App identity and permissions

Use only the existing Kirisame App owned by CyanAutomation. Do not create another App or use a personal access token or GitHub user OAuth.

Configure these repository permissions on the App:

| Permission | App access | Runtime use |
| --- | --- | --- |
| Metadata | Read-only | Resolve repository and installation identity. |
| Contents | Read and write | Read base objects and write blobs, trees, commits, and publication refs. |
| Pull requests | Read and write | List, create, and reconcile PRs in PR mode. |

Do not grant Workflows, Administration, Actions, secrets, checks, deployments, or organization permissions. Workflow files and changes to `.gitattributes` are rejected by Kirisame.

Install the App only on explicitly selected repositories. The App installation's selected repositories and Kirisame's own allowlist are separate authorization gates. Do not install on all repositories by default.

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

The App JWT uses RS256, sets `iat` 60 seconds in the past, and expires within GitHub's 10-minute maximum. The optional Client ID can be used as the issuer; otherwise the App ID is used. See GitHub's [JWT guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) and [installation token guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

Normal CI exercises signing and HTTP behavior using ephemeral keys and mocked GitHub responses. It does not need Cloudflare or GitHub credentials. A successful build or mock test does not prove the live App installation is usable.

## Authorised canary procedure

Do not select a repository automatically. A user or repository owner must explicitly identify a disposable test repository and authorize its use. Do not use production Soyuz to start the test.

1. Confirm the approved repository, its default base branch, and that the Kirisame App is installed only on the approved repository.
2. Use an isolated canary Worker/environment with a private-only invocation path. Keep the public production Worker's publishing flag false.
3. Add only the approved repository and required operations/base branch to the canary allowlist. Store the private key as a Worker secret.
4. Verify installation and permission resolution through the canary's private test harness without printing JWT or token values.
5. Publish a small text-file change and confirm its branch, commit parent/tree, App author identity, and normal PR head/base/marker.
6. Replay the identical request and verify that the same branch and PR are returned without duplicate create operations.
7. Verify an unrelated repository is rejected before token issuance, the public publishing path remains inaccessible, and diagnostics contain no credentials or file contents.
8. Record the approved repository, branch, commit, PR URL, and sanitized result. Do not merge, close, or delete the test PR automatically.

The canary was not run as part of this implementation because no disposable repository or private key was supplied. Do not broaden the allowlist or create credentials to make the test pass.

## Troubleshooting

| Safe error | Likely cause and response |
| --- | --- |
| `PUBLISHING_UNAVAILABLE` | Publishing is disabled or required configuration is absent/invalid. Confirm environment and keep the commissioning gate closed until reviewed. |
| `REPOSITORY_NOT_ALLOWED` | The exact owner/repository is not in the Kirisame allowlist. Verify the approved spelling and JSON policy. |
| `APP_NOT_INSTALLED` | The App is not installed on that repository, is suspended, or the returned repository identity does not match. Review installation selection. |
| `GITHUB_PERMISSION_DENIED` | The installation/App lacks a permission required for the selected operation. Grant only the missing repository permission after review. |
| `GITHUB_AUTH_INVALID` | GitHub rejected the App JWT or returned an invalid token scope/expiry. Rotate a revoked key through the approved process; never expose token values in diagnostics. |
| `GITHUB_RATE_LIMITED` | GitHub returned a rate limit. Honor `Retry-After` and let Soyuz's future durable scheduler retry the same immutable request. |
| `GITHUB_TIMEOUT` or `GITHUB_UNAVAILABLE` | The response was transient or uncertain. Reconcile GitHub state before retrying; do not assume a timed-out mutation failed. |

The Worker deliberately does not return raw GitHub response bodies. Use Cloudflare's access-controlled logs and GitHub's App/installation settings to diagnose the safe error category.

## Rotation, revocation, and rollback

To rotate a key, generate a replacement through GitHub's App settings, store it directly as the Cloudflare Worker secret, deploy/update the isolated target, verify a private canary, then revoke the old key after the rollout is confirmed. If the key is suspected compromised, revoke it immediately, keep `PUBLISHING_ENABLED=false`, and investigate access using GitHub and Cloudflare audit records. Never copy old or new key bytes into logs or an issue.

To revoke repository access, remove that repository from the App installation selection and from the Kirisame allowlist. To disable all publishing, set `PUBLISHING_ENABLED=false` or clear the allowlist, then verify `/readyz` reports `503` and the private publisher returns `PUBLISHING_UNAVAILABLE`.

Use the rollback process in [Operations](OPERATIONS.md) for Worker versions. After rollback, verify public diagnostics, the disabled publishing state, and any Service Binding configuration. Do not roll back to a version that can expose a public publishing route.

## Requirements before Soyuz integration

Soyuz production publishing remains out of scope. Before connecting `KIRISAME`, Soyuz must add a durable publication record with a unique publication ID, immutable request fingerprint, compare-and-set attempt lease, retry schedule, append-only history, and artifact retention pin. Soyuz must authorize from canonical run state and trusted validation evidence; executors must provide the v1 manifest under the current claim fence. Then deploy the receiver first, attach a private Service Binding only to Soyuz, and enable Soyuz dispatch in a separately reviewed rollout. See [Soyuz integration](SOYUZ-INTEGRATION.md) and [Phase status](PHASE1-PLAN.md).
