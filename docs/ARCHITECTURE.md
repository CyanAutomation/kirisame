# Kirisame architecture

**Status:** Phase 0.1 contracts, Phase 1.1 publishing hardening, Phase 2A GitHub App authentication/adapter, and authenticated caller-key RPC are implemented. The existing authenticated preflight and PR #128 replay are historical evidence. The latest review could not verify current Worker versions, binding, or caller secrets. Soyuz source declares enabled dispatch and the exact Somatic PR-to-`main` policy; trusted-host readiness and a new canonical-run canary remain pending. See the [Phase 2C.1 readiness snapshot](https://github.com/CyanAutomation/soyuz/blob/codex/phase-2c1-publication-reliability/docs/PHASE-2C1-READINESS.md).

## Intended system

Kirisame is an independently deployed Cloudflare Worker designed to serve as the GitHub publication boundary. Its intended initial caller is Soyuz over a private Cloudflare Service Binding. Kirisame is not an MCP or UTCP service and has no agent-facing discovery API.

~~~mermaid
flowchart LR
  subgraph Z1["Untrusted execution zone"]
    K["Kaseki-Agent"]
    R["Rusty-Fossil executor (future)"]
  end
  subgraph Z2["Artifact zone: bytes are still untrusted"]
    A["Immutable file-change manifest"]
  end
  subgraph Z3["Trusted Soyuz control plane"]
    S["Soyuz API and canonical D1 run state"]
    O["Publication authorization and lifecycle"]
    B["Private Service Binding"]
    S --> O --> B
  end
  subgraph Z4["Trusted Kirisame Worker"]
    V["Contract, provenance and policy validation"]
    G["GitHub App token and Git Data adapter"]
    V --> G
  end
  subgraph Z5["GitHub"]
    GH["Repository refs, commits and pull requests"]
  end
  K -->|"claim-fenced artifact upload"| A
  R -.->|"future executor-neutral upload"| A
  A -->|"Soyuz verifies run association and retains"| S
  B -->|"v1 request + verified manifest"| V
  G -->|"scoped installation token"| GH
  G -->|"sanitized result"| B
  B --> O
~~~

### Ownership

| Component | Owns |
| --- | --- |
| Coding executors | Code changes, local validation and quality gates, and producing publication artifacts. They receive no GitHub write credential. |
| Soyuz | Canonical execution identity and state, publication eligibility, publication ID, artifact provenance and retention, and canonical publication lifecycle. |
| Kirisame | Private caller authentication, GitHub App authentication, verified Git object and branch publication, pull request creation or reconciliation, and sanitized publication results. |
| GitHub | Repository state, commits, branches, pull requests, reviews and repository rules. |

Kirisame does not run coding agents, tests, arbitrary Git commands, merges, or deployments. It does not decide whether a run should be published. It only accepts explicit v1 operations, branch or pr.

## Existing behavior and migration target

The following describes the current related repositories as inspected on 2026-11-20. Existing behavior is not the intended final ownership model.

- **Soyuz** is already a Cloudflare control plane. It assigns canonical RFC 9562 UUIDv7 run IDs and separate human-facing soyuz-N display IDs; persists runs and events in D1; sends normalized, version-1 run messages through Cloudflare Queues; and accepts claim-fenced worker callbacks. The regular POST /v1/runs route defaults publishMode to pr. The companion Soyuz change aligns POST /v1/agent/runs and UTCP with that policy; before that change, those agent entry points defaulted to none. The current run contract accepts auto, none, branch and pr, with non-pr values reserved for explicit test exceptions. See the [Soyuz README](https://github.com/CyanAutomation/soyuz/blob/main/README.md), [architecture](https://github.com/CyanAutomation/soyuz/blob/main/docs/ARCHITECTURE.md), [transport contract](https://github.com/CyanAutomation/soyuz/blob/main/docs/CONTRACT.md), and [request schema](https://github.com/CyanAutomation/soyuz/blob/main/src/contracts/run-request.ts).
- **Soyuz publication storage** uses a separate private R2 manifest prefix and D1 ledger. Migration `0009` adds claim-fenced manifest indexing, publication intents, attempts, events, and retention independent of run culling. Production migration `0009` is applied. See [Soyuz publication lifecycle](https://github.com/CyanAutomation/soyuz/blob/main/docs/KIRISAME-PUBLICATION.md) and [retention implementation](https://github.com/CyanAutomation/soyuz/blob/main/src/api/retention.ts).
- **Kaseki-Agent** currently owns GitHub publication inside its execution workflow. Its API and host defaults are pr, and the companion Kaseki change aligns its CLI configuration fallback from auto to pr. The controller still accepts auto, none, branch and pr; explicit non-pr values are test exceptions, and normal pr mode requires credentials rather than silently skipping publication. The host reads the GitHub App ID, client ID and private-key files; the client ID is used for credential validation, while the TypeScript helper creates an App JWT, resolves the installation, requests an installation token and retries selected transient requests. In `kaseki-agent.sh`, the publishing step checks out `kaseki/$INSTANCE_NAME`, stages the paths in `changed-files.txt`, commits with a `Kaseki: $INSTANCE_NAME` message, and pushes with Git CLI using `--force-with-lease`. Branch mode stops after the push. PR mode posts a non-draft PR and retries creation with bounded 2/4/8-second backoff by default. Kaseki exposes publish mode, PR URL, push evidence and diagnostics in its local result; the Soyuz adapter derives publishedUrl from result metadata and sends it with the terminal completion callback. See [publication settings](https://github.com/CyanAutomation/kaseki-agent/blob/main/docs/ENV_VARS.md), [GitHub utilities](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/github-utils.ts), [token helper](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/github-app-token.ts), [shell publisher](https://github.com/CyanAutomation/kaseki-agent/blob/main/kaseki-agent.sh), [Kaseki API routes](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/kaseki-api-routes.ts), [Soyuz artifact adapter](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/integrations/soyuz/soyuz-artifacts.ts), and [Soyuz host guide](https://github.com/CyanAutomation/kaseki-agent/blob/main/docs/SOYUZ_INTEGRATION.md).
- **Rusty-Fossil** is a Rust host-controller foundation for Soyuz Queue and callback contracts. Its production intake is disabled, it has no Docker or coding executor, and it has no repository checkout or GitHub publishing capability. It treats Queue input as untrusted and requires Soyuz claim and start proofs. See its [README](https://github.com/CyanAutomation/rusty-fossil/blob/main/README.md), [architecture](https://github.com/CyanAutomation/rusty-fossil/blob/main/docs/ARCHITECTURE.md), and [compatibility inventory](https://github.com/CyanAutomation/rusty-fossil/blob/main/docs/COMPATIBILITY.md).

Kaseki's current legacy path performs validation and GitHub publishing before Soyuz receives its completed callback. That callback may contain `publishedUrl`. Soyuz now has a separate publication record and publication state machine for the new Kirisame path. This integration does not change existing run terminal states or callback schemas.

The migration boundary is deliberate: the new Kaseki and future Rusty-Fossil execution paths upload the same executor-neutral manifest to Soyuz and hold no GitHub write credentials in the coding container. Soyuz authorizes and dispatches the publication. Kirisame replaces Kaseki's repository shell, local Git commit/push, force-with-lease branch update and in-process PR retry loop with bounded Git Data API operations, deterministic create-only `kirisame/p/{publicationId}` refs, and read-before-retry reconciliation. Kirisame never force-updates or deletes a pre-existing branch; an unrelated ref is a conflict requiring a new authorization and publicationId.

## Trust boundaries

1. **Untrusted execution:** Generated code, repository files, executor output, and claims emitted from a disposable coding environment are untrusted. A success message or validationPassed flag alone grants no write authority.
2. **Validated but untrusted artifact:** The manifest remains untrusted input after a successful coding run. Soyuz binds it to its canonical run and current worker claim, validates trusted execution evidence, stores it immutably, and authorizes a specific publication. Kirisame still verifies the bytes, digest, paths, operation set and declared base.
3. **Trusted callers:** Soyuz reads canonical run and validation evidence, resolves publishMode and destination, chooses the publicationId, locks the artifact to that run, and applies its own repository policy. Each private caller has a separate API key stored as a Worker secret; the key authenticates the service but does not authorize a repository.
4. **Kirisame publication service:** Kirisame accepts requests only through authenticated private bindings. It validates the complete v1 request and artifact. It has no repository allowlist; GitHub installation access and permissions limit the operations it can perform. The current App installation selects all repositories, so it does not currently narrow repo selection.
5. **GitHub:** GitHub is the authority for installed repositories, refs, commit objects, open or closed pull requests, and branch protections. A successful request from Soyuz does not override repository policy or GitHub rules.

The production Worker exposes a separate named typed-RPC `PublisherEntrypoint`; the default public handler cannot dispatch to it. Code defaults are fail-closed. The previous deployed release was restricted to Somatic PRs to `main` and passed its private canary. Kaseki's trusted producer is implemented in source, and Soyuz's checked-in configuration declares the private binding with dispatch enabled; active production settings and host rollout remain to be verified. Kirisame has no public publishing route. Caller-supplied validation booleans, executor-supplied authorization, arbitrary artifact URLs, and arbitrary Git or GitHub operations are never accepted.

## Publication sequence

~~~mermaid
sequenceDiagram
  participant E as Kaseki-Agent or future Rusty-Fossil executor
  participant S as Soyuz
  participant R as private Soyuz R2
  participant K as Kirisame
  participant G as GitHub
  E->>S: claim-fenced execution callbacks and artifact upload
  S->>S: verify canonical run, completion, validation evidence and policy
  S->>R: retain immutable manifest under run and publication identity
  S->>S: resolve auto/none; create publication record for branch or pr
  S->>K: private binding: v1 request, caller ID and separate API key
  K->>K: authenticate caller; validate contract, provenance and manifest
  K->>G: check App installation and permissions for requested repo
  G-->>K: repository-scoped installation token
  K->>G: read target ref and base tree
  G-->>K: expected base state
  K->>G: create blobs/tree/commit and create-only feature ref
  G-->>K: branch commit, or a conflict to reconcile
  opt mode is pr
    K->>G: find existing PR by head/base and publication marker
    G-->>K: existing PR or confirmed absence
    K->>G: create PR only after absence is confirmed
    G-->>K: open PR, or uncertain response to reconcile
  end
  K-->>S: bounded result with outcome, branch/PR and retry status
  S->>S: persist publication transition independently of execution status
~~~

## Platform boundary

The target is one independent Worker with a private Service Binding. The current runtime exposes public diagnostics only and has no Service Binding, D1, KV, Queue, Durable Object, Workflow or new R2 resource. Soyuz remains the intended durable lifecycle owner. A Kirisame journal is not a Phase 0.1 or Phase 1 resource.

The artifact request is intentionally small and bounded: at most 5 MiB decoded file content, 100 paths, 1 MiB per file, and 8 MiB for canonical manifest JSON. This is a contract policy, not a Cloudflare limit. Cloudflare documents a 128 MiB isolate memory limit and recommends bounding or streaming bodies; request body caps at public Worker ingress depend on the zone plan. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).

## Decisions and follow-on work

The ADRs in [docs/adr](adr/0001-standalone-worker.md) record the service, caller, credentials, artifact, lifecycle, GitHub API, retry and default-publish-mode decisions. The cross-project default policy is in [Publish mode policy](PUBLISH-MODE-POLICY.md); the work required before publishing can be enabled is listed in [Soyuz integration](SOYUZ-INTEGRATION.md) and the [Phase 1 plan](PHASE1-PLAN.md).
