# GitHub App setup and operations

## Current state

Kirisame uses the CyanAutomation GitHub App, App ID `3345400`, for publication. The production App installation currently selects all repositories. The App owner has accepted the installation scope and current permission grants for commissioning. The App's private key is a Cloudflare Worker secret; its value is not in this repository.

The last deployed publisher used a repository allowlist and a keyless private RPC. This follow-up changes the target design: callers authenticate with per-service API keys, and Kirisame has no repository allowlist. Until the authenticated receiver and callers are deployed together, keep the current production settings and Soyuz dispatch gate in their existing safe state. The release sequence is below.

## App identity, installation, and permissions

Use the existing Kirisame App owned by CyanAutomation. Do not create another App or use a personal access token or GitHub user OAuth.

| Permission | Current App grant | Kirisame token use |
| --- | --- | --- |
| Metadata | Read | Repository and installation identity. |
| Contents | Read and write | Read base objects and write blobs, trees, commits, and publication refs. |
| Pull requests | Read and write | List, create, and reconcile PRs in PR mode. |
| Actions | Read | Not requested by the publisher. |
| Checks | Read and write | Not requested by the publisher. |
| Commit statuses | Read and write | Not requested by the publisher. |

The current install selection is **all repositories**, so it is not currently a repository-level restriction. The GitHub App's selected-repository list can provide an independent repository ceiling if the App owner changes the installation to selected repositories. Do not describe the present all-repositories selection as a repo allowlist.

For each call, Kirisame resolves the installation for the requested repository, verifies App identity, owner, suspension state, permissions, and returned repository identity, then requests a short-lived token scoped to that one repository. A branch operation needs Contents write. PR mode also needs Pull requests write. The returned token must contain exactly the requested repository and minimum permissions plus Metadata read, and must expire in the future. The adapter keeps it only in that request-local instance.

Do not add Workflows, Administration, secrets, deployments, or organization permissions. Kirisame rejects workflow files and `.gitattributes` changes.

## Private caller keys and repository choice

Kirisame's private entrypoint requires `(requestJson, callerId, apiKey)`. The key stays separate from the canonical v1 request and is never logged or stored with publication data. `KIRISAME_CALLER_KEYS` is a Kirisame Worker secret containing a JSON map of caller IDs to accepted key arrays. Every caller keeps its own key in `KIRISAME_API_KEY` as a Worker secret and sends a non-secret `KIRISAME_CALLER_ID`.

Kirisame intentionally has no repository allowlist. Each authenticated caller chooses the repository under its own authorization logic. Soyuz retains its `PUBLICATION_REPOSITORY_ALLOWLIST`, currently Somatic PRs to `main`; the live canary caller and local harness validate their fixed target. An API key identifies a trusted service and does not restrict its repository choice. Do not issue keys to coding executors or services that accept arbitrary repository targets.

Follow [Private RPC authentication and repository policy](PRIVATE-RPC-AUTH.md) for key format, secret names, rotation, and the current App installation scope. Never include secrets in `cloudflare.config.ts`, `wrangler.jsonc` vars, source control, fixtures, shell history, Workflow payloads, ticket comments, or chat.

## GitHub App private key

Generate or replace an App private key only during an approved rotation. Download the unencrypted PEM from the GitHub App settings page and enter it directly as Cloudflare secret `GITHUB_APP_PRIVATE_KEY` for Worker `kirisame`. Kirisame supports unencrypted RSA PKCS#1 (`RSA PRIVATE KEY`) and PKCS#8 (`PRIVATE KEY`) PEM. Do not save the value to a repository, local `.env`, test fixture, or command history.

`GITHUB_APP_ID=3345400` is text configuration. `GITHUB_APP_CLIENT_ID` is optional and, if present, is used as the JWT issuer. The App JWT uses RS256, sets `iat` 60 seconds in the past, and expires within GitHub's 10-minute maximum. The Client ID is not needed for this machine-to-machine flow.

Never print or log the private key, App JWT, installation token, or `Authorization` header. Do not put token material in deployment variables, a request, result, D1, KV, R2, or Queue message.

## Failure handling

App installation and permission failures are policy errors. Kirisame returns a safe `blocked` result with `retryable: false`; it does not automatically retry them. Soyuz records the failure and `publication.blocked` event. Network timeouts, GitHub 5xx responses, and rate limits remain retryable and use Soyuz's existing immutable request and reconciliation flow.

| Result | Meaning | Recovery |
| --- | --- | --- |
| `UNAUTHORIZED_CALLER` | Missing, invalid, unknown, or stale caller credential. | Check the caller ID, both Workers' secret names, and rotation overlap. Update secrets through Cloudflare without printing key values. No request parsing or GitHub action occurs. |
| `APP_NOT_INSTALLED` | No usable App installation for the requested repository, a suspended installation, or a repository identity mismatch. | Confirm the repo exists and the App is installed for its owner. If the installation is limited to selected repos, add the repo; ask the App owner to restore a suspended installation. Run the private read-only preflight again. |
| `GITHUB_PERMISSION_DENIED` | The App or installation grant is below the permission required for the selected operation, or GitHub denies the scoped token/operation. | Review Contents permission; PR mode also requires Pull requests. Have the App owner grant only the missing permission and accept any installation update, then run preflight again. |
| `GITHUB_AUTH_INVALID` | GitHub rejected the App credential or the token failed validation. | Check App ID and private-key secret binding without displaying its value. Rotate only if revoked or invalid. |

Installation and permission checks run before branch creation. If GitHub changes grants mid-request, a branch may already exist; do not delete or force-update it. Inspect Soyuz's blocked publication and GitHub state before using an authorized recovery. There is no automatic retry for blocked policy outcomes.

The adapter never returns raw GitHub response bodies. Use access-controlled Cloudflare logs and GitHub App settings to diagnose the sanitized error code. A build or mock test does not verify a live installation.

## Staged release and canary

The receiver and caller RPC signatures must be deployed as a coordinated rollout. Keep `PUBLICATION_DISPATCH_ENABLED=false` in Soyuz throughout this sequence.

1. Merge and deploy the receiver and caller code with unit tests passing. The new RPC method rejects missing credentials. Keep the existing publishing gate and production allowlist setting until the authenticated path is ready; the new receiver ignores that retired setting.
2. Generate separate high-entropy keys for `soyuz` and `kirisame-live-invoker`. Set `KIRISAME_CALLER_KEYS` on Kirisame and `KIRISAME_API_KEY` on each caller as Cloudflare Worker secrets; set the non-secret caller IDs in text configuration. Do not print the key values.
3. Confirm the private `KIRISAME` Service Bindings target `kirisame.PublisherEntrypoint`. Keep public HTTP publishing unavailable. Remove the obsolete `GITHUB_REPOSITORY_ALLOWLIST` Worker variable after the authenticated receiver is deployed.
4. Invoke the live invoker's authenticated read-only `preflight`. Require `{ status: "verified", repository: "CyanAutomation/somatic" }`. Use `app-scope-probe` and require an `APP_NOT_INSTALLED` or `GITHUB_PERMISSION_DENIED` result for its fixed nonexistent repository; this confirms the GitHub App boundary rather than a Kirisame repository list.
5. Use a new canonical Soyuz run and publication ID. Ensure Kaseki's legacy publisher is disabled for that run. Confirm the claim-bound manifest/evidence/intent, D1 events, authenticated private RPC result, and resulting PR. Replay the exact request and confirm it reuses the same PR. Keep merge or cleanup manual.
6. Keep Soyuz dispatch disabled until the producer-host route and no-dual-publisher checks pass. Then enable dispatch through the existing Soyuz release process. Do not broaden the caller-side repository policy as part of this receiver change.

The older allowlist-denial canary steps in historical operations records describe the previous design. The App-scope probe replaces them for new authenticated canaries.

## GitHub API behavior

Git Data API commits use the top-level `sha`, `tree`, `parents`, and `message` fields. Tree reads use the documented `truncated` and tree-entry fields, fetch each subtree separately, and reject truncated results. See GitHub's [Get a Git commit](https://docs.github.com/en/rest/git/commits#get-a-commit) and [Get a tree](https://docs.github.com/en/rest/git/trees#get-a-tree).

Normal CI signs tokens with ephemeral keys and mocks GitHub HTTP responses. It does not need Cloudflare or GitHub credentials.
