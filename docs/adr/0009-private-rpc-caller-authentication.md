# ADR 0009: Authenticate private publisher callers and delegate repository choice

**Status:** Accepted

## Context

Kirisame is called through Cloudflare Worker Service Bindings. The binding keeps publication off the public HTTP API, but any trusted Worker with a binding can invoke the publisher. Kirisame previously added a second repository allowlist alongside caller-side policy. The current GitHub App installation selects all repositories, so that App setting is not itself a repository restriction.

## Decision

- Require every publisher/preflight RPC caller to send a stable `callerId` and its own high-entropy API key as arguments separate from the immutable v1 request JSON.
- Store accepted caller keys in the Kirisame Worker secret `KIRISAME_CALLER_KEYS`; store each caller key as its own `KIRISAME_API_KEY` Worker secret. Support one previous key during a short rotation overlap.
- Reject unauthenticated calls before parsing the request or performing GitHub operations. Never log, persist, or include keys in results.
- Remove Kirisame's repository allowlist. Each authenticated caller must select and authorize its destination. Soyuz owns its own repository policy; the initial policy restricts it to Somatic PRs targeting `main`.
- Resolve the GitHub App installation for the requested repository and scope every installation token to exactly that repository and the minimum operation permissions.

## Security consequences

An API key identifies a trusted service; it does not authorize a repository. Every key-bearing service is trusted to enforce its own repository selection. Do not give keys to coding executors or callers that accept arbitrary destinations.

GitHub App installation and permissions remain an independent capability boundary. With the current all-repositories installation, the App grants no additional repository selection restriction; changing it to selected repositories would cap all callers. Contents and Pull requests grants constrain the GitHub operations available to the app. Missing installation or insufficient permissions return sanitized non-retryable blocked results and are recorded by Soyuz without automatic retries.

The request v1 contract and digest are unchanged because caller credentials are out-of-band RPC arguments. The named RPC signature must be deployed with its callers. Keep Soyuz dispatch disabled until caller secrets, App preflight, trusted producer rollout, and the no-dual-publisher check pass.

## Alternatives considered

- Keep a duplicate receiver-side repository allowlist: rejected because it duplicates caller authorization and requires two policy updates for a destination change.
- Trust Service Binding isolation alone: rejected because it cannot identify which bound Worker made the RPC and offers no per-caller secret rotation/revocation.
- Put the key inside the v1 request or artifact digest: rejected because credentials must not change immutable publication identity or be stored with the artifact.
- Give every caller the GitHub App private key: rejected because only Kirisame should mint installation tokens.
