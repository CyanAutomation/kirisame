# Kirisame

**Secure, centralised GitHub publishing for CyanAutomation.**

Kirisame is a standalone, Cloudflare-native publication service responsible for securely committing validated code changes, creating repository branches, and opening GitHub pull requests on behalf of trusted automation systems.

It provides a dedicated boundary between systems that **generate code** and systems authorised to **publish code**.

> **Project status:** Phase 0 — architecture and contract foundation completed. This repository contains versioned JSON Schemas and offline fixture validation; no Worker, GitHub authentication, or publishing runtime is implemented.

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

## GitHub authentication

Kirisame uses a dedicated GitHub App.

| Property | Value |
|---|---|
| GitHub App | Kirisame app |
| Owner | [CyanAutomation](https://github.com/CyanAutomation) |
| App ID | `3345400` |
| Authentication | GitHub App installation access tokens |
| Credential storage | Cloudflare Worker secrets |
| Intended installation scope | Explicitly authorised repositories |

### Authentication flow

Kirisame authenticates using the GitHub App private key and configured App ID.

For each authorised publication, the service:

1. Resolves the appropriate GitHub App installation.
2. Generates a short-lived signed GitHub App JWT.
3. Requests an installation access token scoped to the intended repository and necessary permissions.
4. Uses the installation token to perform the approved GitHub operations.
5. Discards the token after use.

Installation tokens must never be returned to Soyuz, coding executors or external callers.

The GitHub App OAuth Client ID is not required for this machine-to-machine authentication flow. Kirisame does not require GitHub user OAuth for its initial implementation.

### Required GitHub permissions

The initial GitHub App permission requirements are expected to include:

| Permission | Level | Purpose |
|---|---|---|
| Metadata | Read | Repository and installation identification |
| Contents | Read and write | Create Git objects, commits and branch references |
| Pull requests | Read and write | Create and reconcile pull requests |

Additional permissions must be introduced only when a specific feature requires them.

Kirisame must not request repository administration privileges or permissions to manage GitHub Actions workflows as part of its initial scope.

The App should be installed only on explicitly selected repositories.

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

The canonical contract is JSON Schema Draft 2020-12 under [contracts/v1](contracts/v1/). It defines publication requests and results, artifact manifests, structured errors and lifecycle events. Run the offline schema and fixture suite with `npm ci && npm run test:contracts`. Contract validation is implemented; publishing is still planned.

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
| Cloudflare Workers | Execute GitHub publication operations |
| Service Bindings | Private communication with Soyuz |
| Worker Secrets | Store GitHub App private key and sensitive configuration |
| Workers Observability | Structured operational logs and diagnostics |

Cloudflare D1, Queues or Workflows may be introduced when justified by publication requirements. They are not mandatory prerequisites for the initial implementation.

### Service interface

The primary production interface should be a private Cloudflare Service Binding exposed to Soyuz.

Kirisame must not expose an unauthenticated public publishing endpoint.

Any future external API must have an explicit authentication, authorisation and rate-limiting model.

Local development should support mocked GitHub interactions without requiring production credentials.

### Configuration

Anticipated configuration includes:

- `GITHUB_APP_ID` — Public GitHub App identifier.
- `GITHUB_APP_PRIVATE_KEY` — GitHub App signing key, stored as a Worker secret.
- Repository authorisation policy — The repositories and publication operations Kirisame may perform.
- Cloudflare Service Binding configuration — Private service integration with Soyuz.

These configuration names are provisional until the implementation contract is finalised.

Production credentials must never appear in source control, test fixtures, application logs or publication artifacts.

## Security model

Kirisame is a security-sensitive service because it holds authority to modify source repositories.

Its security design must assume that code-generation environments, generated artifacts and repository contents may contain untrusted input.

The initial implementation must enforce the following requirements:

**Credential isolation**

GitHub App private keys and installation tokens remain within Kirisame. They must not be exposed through API responses, logs, artifacts or diagnostic endpoints.

**Explicit repository restrictions**

Only configured repositories may be modified. Repository names, branch names, and other GitHub identifiers must be validated against the applicable authorisation policy.

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

### Phase 1 — Cloudflare Worker foundation

- Establish a strict TypeScript project.
- Introduce the Cloudflare Worker runtime and deployment configuration.
- Implement a private publication interface.
- Add structured errors, logging and health diagnostics.
- Provide a mock GitHub adapter for local development and tests.
- Establish CI, linting, type checking and test coverage.

### Phase 2 — GitHub App integration

- Integrate the Kirisame GitHub App.
- Implement short-lived installation token generation.
- Introduce repository and permission checks.
- Implement Git object, commit and branch publication.
- Implement pull request creation and reconciliation.
- Add safe retry and failure handling.

### Phase 3 — Soyuz integration

- Establish a private Service Binding between Soyuz and Kirisame.
- Implement canonical publication authorisation.
- Define and persist publication lifecycle status.
- Connect validated execution artifacts to publication requests.
- Verify idempotency and recovery across service restarts.

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
- [Phase 1 implementation plan](docs/PHASE1-PLAN.md)
- [Architecture Decision Records](docs/adr/)
- [Contract schemas](contracts/v1/) and [fixture tests](tests/contracts/)

Relevant platform documentation:

- [GitHub Apps authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app)
- [GitHub REST API](https://docs.github.com/en/rest)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)

---

**Kirisame is the trusted GitHub publication boundary for CyanAutomation: executors produce validated changes, Soyuz authorises their publication, and Kirisame performs the GitHub writes.**
