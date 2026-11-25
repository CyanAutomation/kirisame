# Kirisame

**Secure, centralised GitHub publishing for CyanAutomation.**

Kirisame is a standalone, Cloudflare-native service designed to commit validated code changes, create repository branches, and open GitHub pull requests on behalf of trusted automation systems.

It provides a dedicated boundary between systems that **generate code** and systems authorised to **publish code**.

> **Project status:** Phase 0.1, Phase 1.1 publishing hardening, Phase 2A GitHub App authentication, and Phase 2A.1 GitHub API compatibility are implemented. The production Worker now requires per-caller API keys and has no repository allowlist. Only the private live-canary invoker is currently authorized; it is fixed to `CyanAutomation/somatic` PRs to `main`. Public HTTP remains diagnostics-only. Soyuz's durable publication ledger is deployed. Kaseki's claim-bound manifest producer and Soyuz's private `KIRISAME` binding are implemented in source but still need trusted-host rollout; Soyuz dispatch remains off.

## Overview

Kirisame separates GitHub write operations from coding agents and orchestration systems.

Rather than distributing GitHub App private keys or installation tokens to ephemeral coding environments, Kirisame centralises GitHub authentication and publication within a dedicated Cloudflare Worker.

Its initial integration is with [Soyuz](https://github.com/CyanAutomation/soyuz), the CyanAutomation control plane, which coordinates execution performed by [Kaseki-Agent](https://github.com/CyanAutomation/kaseki-agent) and [Rusty-Fossil](https://github.com/CyanAutomation/rusty-fossil).

Kirisame uses the dedicated **Kirisame app** GitHub App identity to perform authorised repository operations.

### Core principles

- **Separation of responsibilities:** Coding agents generate and validate changes; Kirisame publishes them.
- **Least privilege:** GitHub write credentials exist only within Kirisame's trusted runtime.
- **Centralised authorisation:** Publication requires approval from a trusted orchestration service.
- **Executor independence:** Any compatible executor can produce publication artifacts without implementing GitHub authentication.
- **Deterministic behaviour:** Identical publication requests must not create duplicate branches or pull requests.
- **Recoverability:** Publication can be retried independently of code generation.
- **Auditability:** Every publication must be traceable to an authorised execution and its validated artifacts.

## Architecture

Kirisame is deployed as an independent Cloudflare Worker with its own source repository, deployment configuration and lifecycle.

The intended architecture is:

**Coding executors → Soyuz → Kirisame → GitHub**

| Component | Responsibility |
|---|---|
| Kaseki-Agent | Generates changes, executes tests, validates output and produces artifacts |
| Rusty-Fossil | Provides an alternative Rust-based coding execution environment |
| Soyuz | Owns canonical runs, authorisation, execution coordination and publication state |
| Kirisame | Validates publication requests, authenticates with GitHub and performs repository writes |
| GitHub | Hosts source repositories, pull requests, reviews and CI workflows |

### Ownership boundaries

**Coding executors own execution.**

Executors are responsible for repository preparation, code generation, testing, quality gates, secret scanning and producing validated publication artifacts.

They must not need GitHub App private keys or GitHub write tokens.

**Soyuz owns orchestration and publication authorisation.**

Soyuz determines whether an execution is eligible for publication, manages the associated artifact references, initiates authorised publication requests and records the resulting publication state.

**Kirisame owns GitHub publication.**

Kirisame performs the GitHub-facing operations required to publish approved changes. It does not execute coding agents, run repository tests, determine task success or independently authorise a coding run.

Kirisame must not become a general-purpose remote Git command execution service.

## Intended GitHub authentication

The Worker contains a Workers-compatible GitHub App authenticator and real GitHub REST adapter. The production receiver authenticates each private Service Binding caller with its own Worker secret and has no receiver-side repository allowlist. The current GitHub App installation selects all repositories, so it does not narrow repository selection; each caller must enforce its own repository policy. The currently authorized live-canary invoker is fixed to Somatic PRs to `main`. The private App key and caller API keys are never stored in this repository.

For each authorized publication, Kirisame uses the dedicated GitHub App.

| Property | Value |
|---|---|
| GitHub App | Kirisame app |
| Owner | [CyanAutomation](https://github.com/CyanAutomation) |
| App ID | `3345400` |
| Authentication | GitHub App installation access tokens |
| Credential storage | Cloudflare Worker secrets |
| Current installation scope | All repositories, accepted by the App owner; a selected-repository installation would add a separate repository ceiling |

### Authentication flow

The runtime uses the GitHub App private key and configured App ID to:

For each authorised publication, the service:

1. Authenticate the caller using its caller ID and per-service API key on the private RPC. Reject missing or invalid credentials before parsing the request.
2. Validate the complete v1 request, manifest provenance, digest, paths, operation, and base identity.
3. Resolve the GitHub App installation for the requested repository and verify its owner, App ID, suspension state and required permissions.
4. Generate a short-lived RS256 JWT and request an installation token for exactly one repository with Contents write, adding Pull requests write only for PR mode.
5. Verify the returned repository scope, permission set and expiry, then use the token for approved GitHub operations. Keep the token only in the request-local adapter and discard it after the call.

Installation tokens must never be returned to Soyuz, coding executors or external callers.

The GitHub App OAuth Client ID is not required for this machine-to-machine authentication flow. Kirisame does not require GitHub user OAuth for its initial implementation.

### Required GitHub permissions

The current App permissions are:

| Permission | Level | Purpose |
|---|---|---|
| Metadata | Read | Repository and installation identification |
| Actions | Read | Existing owner-approved grant; not requested by Kirisame's publication token |
| Checks | Read and write | Existing owner-approved grant; not requested by Kirisame's publication token |
| Contents | Read and write | Create Git objects, commits and branch references |
| Commit statuses | Read and write | Existing owner-approved grant; not requested by Kirisame's publication token |
| Pull requests | Read and write | Create and reconcile pull requests |

The App owner accepts these current grants for commissioning. Kirisame's runtime still requests and validates only the permissions needed for the selected operation, plus Metadata read, and scopes the token to exactly one repository.

Kirisame must not request repository administration privileges or permissions to manage GitHub Actions workflows as part of its initial scope.

The current all-repositories installation is accepted by the App owner. Kirisame has no repository allowlist: each authenticated caller must enforce its own repository policy. Soyuz currently limits its publication caller to Somatic PRs targeting `main`; an App installation restricted to selected repositories would independently cap all callers.

## Publication contract

Kirisame exposes a versioned publication contract, independent of any particular coding agent.

The contract defines the data required to transform an approved execution result into a GitHub branch and pull request.

A publication request is expected to contain, or securely reference:

| Field | Purpose |
|---|---|
| `contractVersion` | Version of the publication protocol |
| `publicationId` | Stable identifier for idempotency and recovery |
| `runId` | Canonical Soyuz execution identifier |
| `repository` | Authorised GitHub repository |
| `baseRef` | Target branch for the pull request |
| `baseSha` | Expected base commit SHA |
| `headRef` | Deterministic publication branch |
| `title` | Proposed pull request title |
| `body` | Proposed pull request description |
| `artifact` | Reference or payload containing validated changes |
| `artifactDigest` | Integrity reference for the publication contents |

The canonical contract is JSON Schema Draft 2020-12 under [contracts/v1](contracts/v1/). It defines publication requests and results, artifact manifests, structured errors and lifecycle events. Runtime validation reuses the same schema-derived TypeScript validators as the contract tests. Run `npm run health` to generate Worker test coverage and produce a measured Fallow health report. Run all checks with `npm ci`, `npm run typecheck`, `npm run lint`, `npm test` and `npm run build`.

### Default publication policy

The default `publishMode` throughout Soyuz, Kirisame and its executor integrations is `pr`. Other modes are rare, explicit exceptions for narrowly scoped tests; they must not become routine configuration defaults or hide missing GitHub credentials. Kirisame's request schema documents `pr` as the client default while still requiring an explicit `mode` at its trusted boundary. See the [cross-project publish mode policy](docs/PUBLISH-MODE-POLICY.md).

### Artifact handling

Publication artifacts must be immutable, bounded and verifiable. Contract v1 uses a structured file-change manifest for UTF-8 additions, modifications and deletions. It defines size, path, ordering and digest rules and rejects unsupported file types or Git operations.

Kirisame must not execute arbitrary shell commands, run scripts extracted from artifacts or evaluate instructions contained in generated source files. Binary files, symlinks, submodules, Git LFS objects and file-mode changes are outside v1. See [artifact handling](docs/ARTIFACTS.md).

### Authorisation

A publication request is valid only when the trusted orchestration layer has established that:

- The associated execution exists and has an approved publication mode.
- Required execution and validation checks have passed.
- The publication artifact is associated with the correct execution.
- The destination repository and target branch are permitted.
- The request has not been superseded or invalidated.

Kirisame must verify the trusted authorisation context and enforce its own repository and operation policies.

Claims supplied only by a coding agent must never be treated as sufficient proof of authorisation.

## Publication workflow

The intended publication lifecycle is:

1. **Execution completed:** A coding executor finishes its task and produces validated artifacts.
2. **Publication authorised:** Soyuz verifies the canonical execution state and determines whether publication is permitted.
3. **Request submitted:** Soyuz invokes Kirisame using a private, authenticated service interface.
4. **Request validated:** Kirisame validates the publication contract, repository scope, artifact integrity and Git references.
5. **GitHub authentication:** Kirisame obtains a suitably scoped GitHub App installation token.
6. **Branch published:** Kirisame uses the GitHub Git Data API to create the necessary objects, commit and feature branch.
7. **Pull request created:** Kirisame opens or reconciles the corresponding pull request.
8. **Outcome recorded:** Kirisame returns a structured result, and Soyuz records the publication status and GitHub URL.

### GitHub operations

Where practical, Kirisame should use the GitHub REST and Git Data APIs directly rather than spawning a Git CLI process.

Publication must support:

- Creating commits and feature branches.
- Creating non-draft pull requests by default.
- Detecting an existing publication for the same request.
- Reconciling incomplete or uncertain GitHub operations.
- Reporting GitHub API failures using structured error codes.
- Rejecting unsafe, unauthorised or conflicting reference updates.

Existing branch references must not be force-updated without a separately defined and authorised policy.

Kirisame must not write directly to protected target branches or merge pull requests as part of the initial implementation.

## Reliability and idempotency

Kirisame must support safe retries and recovery from partial GitHub failures.

A failed network request does not necessarily mean that a GitHub operation failed. Kirisame must reconcile GitHub's observable state before repeating a mutation.

The `publicationId` is the primary idempotency identifier.

Repeated requests carrying the same identifier and equivalent immutable contents should resolve to the same publication outcome.

Reusing an identifier for different publication contents must be rejected.

Publication status should be represented independently of execution status.

Proposed publication states include:

| State | Meaning |
|---|---|
| `pending` | Publication authorised but not yet started |
| `publishing` | GitHub operations in progress |
| `published` | Successful publication with a confirmed GitHub reference |
| `retryable_failure` | Temporary failure eligible for reconciliation and retry |
| `blocked` | Permanent failure or policy rejection requiring intervention |

Soyuz remains the canonical owner of the publication lifecycle. Kirisame should avoid duplicating that state unnecessarily.

A dedicated Kirisame persistence layer should only be introduced when needed for reliable operation reconciliation, idempotency or auditing.

## Cloudflare platform

Kirisame is designed as a lightweight, Cloudflare-native TypeScript service.

### Initial platform components

| Component | Purpose |
|---|---|
| Cloudflare Workers | Run the public diagnostics and the private, explicitly gated GitHub publisher |
| Service Bindings | Production has only the private canary invoker; Soyuz source declares `KIRISAME` with dispatch off, pending rollout |
| Worker Secrets | GitHub App key, Kirisame caller-key map, and one API key per calling Worker; values stay out of source control |
| Workers Observability | Structured operational logs and diagnostics |

Cloudflare D1, Queues or Workflows may be introduced when justified by publication requirements. They are not mandatory prerequisites for the initial implementation.

### Service interface

The private interface is a typed Cloudflare Service Binding named `KIRISAME`, with `PublisherEntrypoint.publish(requestJson, callerId, apiKey)`. The key is a separate RPC argument and does not change v1 canonical JSON or its digest. The request is capped at 9 MiB UTF-8 before parsing. The public Worker exposes only `/`, `/health` and `/readyz`; requests to `/internal/v1/publications` return 404 and cannot invoke publication logic.

The code default for `PUBLISHING_ENABLED` remains `false`; production overrides it to `true`. The deployed receiver has no repository allowlist; every caller has a separate Worker API-key secret, and caller policy selects the destination. The test-only binding injects a mock adapter and is not part of the production Worker entrypoint. Kirisame must not expose an unauthenticated public publishing endpoint.

Any future external API must have an explicit authentication, authorisation and rate-limiting model.

Local development and CI exercise mocked GitHub interactions without requiring production credentials. See [Operations](docs/OPERATIONS.md) for development, deployment preflight, public diagnostics and rollback instructions.

### Configuration

The checked-in configuration includes these fail-closed settings:

- `PUBLISHING_ENABLED=false` — fail-closed code default; production has an explicit `true` override and requires an authenticated caller.
- `GITHUB_APP_ID=3345400` — public GitHub App identifier.
- `GITHUB_APP_CLIENT_ID` — optional JWT issuer identifier.
- `GITHUB_APP_PRIVATE_KEY` — Worker secret binding with no value in source control.
- `KIRISAME_CALLER_KEYS` — Worker secret mapping caller IDs to current and short-lived previous API keys.
- Caller Workers set a text `KIRISAME_CALLER_ID` and secret `KIRISAME_API_KEY`.

The code default for `PUBLISHING_ENABLED` is `false`. Readiness validates local configuration, including that caller keys exist; it does not authenticate a caller or prove that GitHub's App installation is usable. The live invoker's private preflight and App-scope probe passed. Soyuz's durable ledger and private binding are implemented in source, but dispatch remains off pending the trusted-host rollout and full end-to-end canary. See [Soyuz integration](docs/SOYUZ-INTEGRATION.md).

Production credentials must never appear in source control, test fixtures, application logs or publication artifacts. See the [GitHub App setup guide](docs/GITHUB-APP.md) before configuring a private canary or rotating the key.

## Security model

Kirisame is a security-sensitive service because it holds authority to modify source repositories.

Its security design must assume that code-generation environments, generated artifacts and repository contents may contain untrusted input.

The initial implementation must enforce the following requirements:

**Credential isolation**

GitHub App private keys and installation tokens remain within Kirisame. They must not be exposed through API responses, logs, artifacts or diagnostic endpoints.

**Caller policy and App capability**

Kirisame has no repository allowlist. Each secret-bearing caller must authorize its own repository choice; Soyuz currently retains its Somatic PR-to-`main` policy. GitHub App installation selection and permission grants are an independent capability ceiling. The current installation selects all repositories, so only a selected-repository installation would narrow repository access.

**Trusted execution provenance**

Publication must be associated with a verified Soyuz run and trusted validation evidence. Untrusted executor-supplied success claims are insufficient.

**Protected Git operations**

Kirisame must reject direct default-branch writes, unsafe reference updates and operations outside the approved publication scope.

**Artifact integrity**

Publication inputs must be validated for size, structure, completeness and integrity. Unsupported changes must fail safely rather than be silently omitted.

**Minimal GitHub permissions**

Installation tokens must be limited to the repositories and permissions required for the particular publication.

**Audit and traceability**

Every publication attempt must be traceable using its publication ID, Soyuz run ID, destination repository and GitHub result. Sensitive values must be redacted.

**Safe failure behaviour**

Authentication, authorisation and policy-check failures must fail closed. Transient GitHub failures must not trigger unbounded retries or duplicate writes.

## Integration strategy

### Soyuz

Soyuz is Kirisame's primary trusted client.

It owns execution provenance, publication eligibility and canonical publication status.

The integration should use a versioned, typed service contract and preserve compatibility during independent deployment and rollback.

### Kaseki-Agent

Kaseki-Agent currently handles GitHub authentication, branch pushing and pull request creation within its execution workflow.

The planned migration will move these responsibilities into Kirisame.

Following migration, Kaseki-Agent will produce validated publication artifacts without requiring GitHub write credentials.

Existing publishing behaviour should remain available during staged migration until the Kirisame integration has been verified.

### Rusty-Fossil

Rusty-Fossil should use the same publication contract and Soyuz authorisation flow.

Its Rust implementation should not require a separate GitHub publishing subsystem or duplicate the GitHub App authentication logic.

### Future consumers

Kirisame may eventually support additional CyanAutomation services that produce approved changes for GitHub.

New consumers should integrate through an authorised control-plane interface rather than receive direct, unrestricted publishing access.

## Project roadmap

### Phase 0 — Architecture and contracts

- **Completed:** Define service ownership and trust boundaries.
- **Completed:** Add publication request, result, artifact, error and event schemas.
- **Completed:** Establish repository, branch and artifact safety requirements.
- **Completed:** Define idempotency, error handling and reconciliation expectations.
- **Completed:** Add deterministic valid/invalid fixtures and executable offline validation.
- **Completed:** Document the Phase 1 plan and cross-repository prerequisites.

### Phase 0.1 — Contract hardening

- **Implemented:** Extract reusable TypeScript schema and semantic validation.
- **Implemented:** Validate nested error taxonomy, result/request consistency, event transitions, Unicode/path safety, canonical artifact bytes and workflow restrictions.
- **Implemented:** Correct reconciliation ordering and add explicit `PUBLISHING_UNAVAILABLE` contract error.

### Phase 1 — Cloudflare Worker foundation

- **Implemented:** Strict TypeScript Worker using `cf`, `cloudflare.config.ts`, Vite and Workers Vitest integration.
- **Implemented:** Public diagnostics plus an isolated private typed RPC entrypoint.
- **Implemented:** Sanitized structured errors and safe operation logs.
- **Implemented:** GitHub adapter interface and deterministic mock publisher. The receiver-side repository allowlist has been removed in the authenticated RPC follow-up.
- **Implemented:** CI, linting, type checking, contract tests and Worker runtime tests.
- **Implemented:** Real GitHub writes through the authenticated private named publisher; production has no receiver-side repository allowlist. The public HTTP handler cannot publish.
- **Pending:** Soyuz's caller secret and trusted-host rollout; Soyuz dispatch remains disabled.

### Phase 1.1 — Publishing hardening

- **Implemented:** Git-compatible mock blob, tree and commit identifiers with nested tree behavior.
- **Implemented:** Fail-closed Git LFS and `.gitattributes` checks, including nested rules and unsupported attributes.
- **Implemented:** Deterministic no-op rejection, request-fingerprint markers, exact PR metadata reconciliation and truncated-tree rejection.

### Phase 2A — GitHub App and real adapter

- **Implemented:** Workers-compatible App JWT signing and traditional RSA private-key import.
- **Implemented:** Installation lookup, exact-requested-repository and minimum-permission token scoping, expiry checks and fail-closed configuration.
- **Implemented:** Real GitHub REST Git Data and Pull Requests adapter with bounded requests, tree traversal, pagination, error classification and reconciliation.
- **Implemented:** Injected-HTTP tests that drive the real publication service through simulated GitHub endpoints.
- **Completed:** Private live canary against `CyanAutomation/somatic`, including a byte-identical replay that reused the same open PR.
- **Implemented:** The GitHub App install and permission checks. Its current installation selects all repositories; Kirisame requests a one-repository, operation-scoped installation token.
- **Follow-up:** Authenticate every private RPC caller with a per-service Worker secret. Soyuz owns repository selection; Kirisame has no repository allowlist.

### Phase 3 — Soyuz integration

- **Implemented in Soyuz:** Durable publication intents and ledger, request fingerprints, attempt fencing, event history, retry recovery, and manifest retention independent of run culling.
- **Implemented in source:** Kaseki pins the base SHA, suppresses its legacy publisher for the persisted Kirisame route, and uploads the claim-bound manifest and validation evidence.
- **Pending:** Roll out the trusted Kaseki producer and authenticated Soyuz binding with dispatch off; enable dispatch only after preflight, caller-policy, and per-run legacy-publisher checks.
- **Pending:** Run a new claim-bound end-to-end canary and verify identical replay and retention.

### Phase 4 — Executor migration

- Migrate Kaseki-Agent to the external publication contract.
- Remove GitHub App private-key access from coding containers.
- Integrate Rusty-Fossil using the same publication mechanism.
- Complete end-to-end tests and production migration.
- Retire legacy publishing code and rotate credentials as appropriate.

## Development principles

Kirisame should remain a small, focused service.

The implementation should favour:

- Strict TypeScript with explicit contracts and validation.
- Cloudflare-native capabilities over unnecessary infrastructure.
- Deterministic, testable business logic.
- Mocked GitHub API interactions for automated testing.
- Clear distinctions between transient failures and permanent policy rejections.
- Independent build, release and deployment lifecycles.
- Backwards-compatible contract evolution wherever practical.

Changes that increase the service's authority must receive explicit review.

Additional GitHub capabilities should be introduced as separately authorised operations, not through a generic endpoint capable of arbitrary repository modification.

## Non-goals

Kirisame is not intended to become:

- A coding agent or LLM execution environment.
- A replacement for Soyuz's orchestration and scheduling capabilities.
- A general-purpose Git hosting or source-control platform.
- A CI/CD runner or replacement for GitHub Actions.
- A general repository administration service.
- A source of GitHub credentials for other services.
- An autonomous pull request approval or merging system.

Commits created by Kirisame may trigger GitHub Actions workflows configured in the destination repository, but Kirisame does not execute those workflows itself.

## Related projects

- [Soyuz](https://github.com/CyanAutomation/soyuz) — Central execution orchestration and control plane.
- [Kaseki-Agent](https://github.com/CyanAutomation/kaseki-agent) — Ephemeral coding agent and execution framework.
- [Rusty-Fossil](https://github.com/CyanAutomation/rusty-fossil) — Rust-based coding execution framework.

## Documentation

- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Publication artifacts and digest rules](docs/ARTIFACTS.md)
- [Security policy and GitHub App permissions](docs/SECURITY.md)
- [Publication lifecycle and reconciliation](docs/LIFECYCLE.md)
- [Soyuz integration contract and migration](docs/SOYUZ-INTEGRATION.md)
- [Cross-project publish mode policy](docs/PUBLISH-MODE-POLICY.md)
- [Phase 1 implementation plan](docs/PHASE1-PLAN.md)
- [Private RPC caller authentication and Worker secrets](docs/PRIVATE-RPC-AUTH.md)
- [Operations and deployment](docs/OPERATIONS.md)
- [Architecture Decision Records](docs/adr/)
- [Contract schemas](contracts/v1/) and [fixture tests](tests/contracts/)

Relevant platform documentation:

- [GitHub Apps authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app)
- [GitHub REST API](https://docs.github.com/en/rest)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)

---

**Kirisame is CyanAutomation's trusted GitHub publication boundary. The production Worker passed a private Somatic PR canary and an identical replay reused the same PR. Soyuz's durable publication ledger is deployed; Kaseki producer and Soyuz binding source are ready, with host rollout and production dispatch still pending.**
