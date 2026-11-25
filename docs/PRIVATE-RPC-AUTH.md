# Private publisher authentication and repository policy

Kirisame exposes publication only through the Cloudflare `KIRISAME` Service Binding and `PublisherEntrypoint`. The RPC requires `(requestJson, callerId, apiKey)`. The key is a separate RPC argument and never enters the immutable v1 request, its digest, publication identity, Soyuz D1/R2, or logs. No public HTTP route accepts publication requests.

## Caller secrets

Each caller uses a distinct 32-byte random API key encoded as unpadded base64url (43 characters). Store the key only as a Cloudflare Worker secret named `KIRISAME_API_KEY` in that caller. Send the caller's stable non-secret ID as `KIRISAME_CALLER_ID`.

The Kirisame Worker has a `KIRISAME_CALLER_KEYS` Worker secret containing a JSON object from caller ID to accepted key strings. The receiver allows one active key and one previous key per caller so rotation can overlap briefly:

```json
{
  "soyuz": ["<43-character-current-key>", "<43-character-previous-key>"],
  "kirisame-live-invoker": ["<43-character-key>"],
  "kirisame-canary-harness": ["<43-character-key>"]
}
```

Use `wrangler secret put KIRISAME_CALLER_KEYS` for Kirisame and `wrangler secret put KIRISAME_API_KEY` in each caller's Worker. Keep caller IDs in text configuration. Do not put key values in checked-in config, `.dev.vars`, commands, CI output, workflow payloads, or application logs. Missing, malformed, unknown, or mismatched credentials fail closed with `UNAUTHORIZED_CALLER` before request parsing or GitHub work. Comparison uses fixed-size SHA-256 digests and a constant-time byte comparison.

For rotation, add the new key to the caller's accepted list, update the caller's `KIRISAME_API_KEY`, verify an authenticated private preflight/canary, then remove the old key from `KIRISAME_CALLER_KEYS`. Give every caller its own key; a key authenticates a service identity, not a repository.

## Who chooses the repository

Kirisame deliberately has no repository allowlist. The authenticated caller determines which repository to request and owns its own admission rules. Soyuz keeps its `PUBLICATION_REPOSITORY_ALLOWLIST` policy and must authorize a repository, operation, and base branch from trusted run state before making the RPC. The live canary invoker and local harness also validate their fixed Somatic target before calling Kirisame.

This makes every API-key holder a trusted publication caller. A caller key alone does not limit repository selection. Never issue a key to an executor or a service that accepts arbitrary repository targets without its own authorization. Kirisame still validates v1 shape, manifest digest, base/provenance identity, safe file changes, deterministic refs, and operation behavior.

## GitHub App as a separate capability boundary

After caller authentication and request validation, Kirisame resolves the configured GitHub App installation for the requested repository and verifies its identity, suspension state, permissions, and repository identity. It asks GitHub for an installation token scoped to exactly that one repository and to the permissions needed for the operation. It validates the returned repository, permission set, and expiry before any write.

The current CyanAutomation App installation selects **all repositories**. Therefore its install selection is a control point, but at present it does not narrow repository access. The caller's own policy remains the repository-selection control. If the App owner later changes its installation to selected repositories, that selection becomes an additional independent ceiling. Its current granted permissions are Metadata read, Actions read, Checks read/write, Contents read/write, Commit statuses read/write, and Pull requests read/write. Kirisame's tokens use only Metadata plus Contents write for branch publication, or Metadata plus Contents write and Pull requests write for PR publication. Actions, Checks, and Commit statuses grants are not requested by Kirisame.

## GitHub App failures and recovery

App installation and permission failures are policy errors, not transient service errors. Kirisame returns a sanitized blocked result with `retryable: false`; it makes no automatic retry. Soyuz records the blocked state and `publication.blocked` event. It does not retry the publication on its timer.

| Result | Meaning | Operator action |
| --- | --- | --- |
| `APP_NOT_INSTALLED` | No usable installation for the requested repo, installation is suspended, or GitHub returned a different repository identity. | Confirm the repository exists and the App is installed for its owner. If the installation is restricted to selected repositories, add this repository. If suspended, have the App owner restore it. Re-run the read-only preflight where applicable. |
| `GITHUB_PERMISSION_DENIED` | The App or installation grant is below the operation's required permission, or GitHub denied the scoped token/operation. | Check the App's Contents permission; PR mode also needs Pull requests. Review the permission change with the App owner and accept any requested installation update. Do not grant broad administration or workflow permissions. |
| `GITHUB_AUTH_INVALID` | GitHub rejected App credentials or the returned token failed validation. | Check the App ID and Cloudflare private-key secret without displaying it; rotate only if the key is revoked or invalid. |

These failures are returned before branch creation when discovered during installation/token preflight. If GitHub changes grants during a request, an already-created deterministic branch can remain; do not delete or force-update it automatically. Fix the App configuration, inspect the blocked publication and GitHub branch/PR state, then use an explicitly authorized recovery/new publication. A caller must not bypass the blocked state by sending an ad-hoc request.

See [GitHub App setup](GITHUB-APP.md), [Soyuz integration](SOYUZ-INTEGRATION.md), and [Operations](OPERATIONS.md).
