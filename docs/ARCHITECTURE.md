# Kirisame architecture

**Status:** Phase 0 architecture baseline. The ownership and service shape follow the Kirisame charter. Cross-repository integration details that require Soyuz changes remain proposals.

## Intended system

Kirisame is an independently deployed Cloudflare Worker and GitHub publication service. Its initial caller is Soyuz over a private Cloudflare Service Binding. Kirisame is not an MCP or UTCP service and has no agent-facing discovery API.

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
| Kirisame | GitHub App authentication, repository and operation policy, verified Git object and branch publication, pull request creation or reconciliation, and sanitized publication results. |
| GitHub | Repository state, commits, branches, pull requests, reviews and repository rules. |

Kirisame does not run coding agents, tests, arbitrary Git commands, merges, or deployments. It does not decide whether a run should be published. It only accepts explicit v1 operations, branch or pr.

## Existing behavior and migration target

The following describes the current related repositories as inspected on 2026-11-20. Existing behavior is not the intended final ownership model.

- **Soyuz** is already a Cloudflare control plane. It assigns canonical RFC 9562 UUIDv7 run IDs and separate human-facing soyuz-N display IDs; persists runs and events in D1; sends normalized, version-1 run messages through Cloudflare Queues; and accepts claim-fenced worker callbacks. Its regular POST /v1/runs route defaults publishMode to pr, while POST /v1/agent/runs defaults it to none. The current run contract accepts auto, none, branch and pr. See the [Soyuz README](https://github.com/CyanAutomation/soyuz/blob/main/README.md), [architecture](https://github.com/CyanAutomation/soyuz/blob/main/docs/ARCHITECTURE.md), [transport contract](https://github.com/CyanAutomation/soyuz/blob/main/docs/CONTRACT.md), and [request schema](https://github.com/CyanAutomation/soyuz/blob/main/src/contracts/run-request.ts).
- **Soyuz artifact storage** is private R2 indexed by D1. Its current upload route limits an artifact to 25,000,000 bytes and a run to 100 artifacts; the current retention window is 30 days, while searchable run history keeps the newest 30 runs. A retention sweep queues object deletion as run rows are culled. This is not yet a publication manifest store with publication-aware retention. See [worker callback schemas](https://github.com/CyanAutomation/soyuz/blob/main/src/contracts/worker-callbacks.ts), [artifact migration](https://github.com/CyanAutomation/soyuz/blob/main/migrations/0003_run_artifacts.sql), and [retention implementation](https://github.com/CyanAutomation/soyuz/blob/main/src/api/retention.ts).
- **Kaseki-Agent** currently owns GitHub publication inside its execution workflow. Its controller accepts auto, none, branch and pr; auto currently skips publication if credentials are absent, while branch and pr require credentials. The host reads the GitHub App ID, client ID and private-key files; the client ID is used for credential validation, while the TypeScript helper creates an App JWT, resolves the installation, requests an installation token and retries selected transient requests. In `kaseki-agent.sh`, the publishing step checks out `kaseki/$INSTANCE_NAME`, stages the paths in `changed-files.txt`, commits with a `Kaseki: $INSTANCE_NAME` message, and pushes with Git CLI using `--force-with-lease`. Branch mode stops after the push. PR mode posts a non-draft PR and retries creation with bounded 2/4/8-second backoff by default. Kaseki exposes publish mode, PR URL, push evidence and diagnostics in its local result; the Soyuz adapter derives publishedUrl from result metadata and sends it with the terminal completion callback. See [publication settings](https://github.com/CyanAutomation/kaseki-agent/blob/main/docs/ENV_VARS.md), [GitHub utilities](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/github-utils.ts), [token helper](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/github-app-token.ts), [shell publisher](https://github.com/CyanAutomation/kaseki-agent/blob/main/kaseki-agent.sh), [Kaseki API routes](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/kaseki-api-routes.ts), [Soyuz artifact adapter](https://github.com/CyanAutomation/kaseki-agent/blob/main/src/integrations/soyuz/soyuz-artifacts.ts), and [Soyuz host guide](https://github.com/CyanAutomation/kaseki-agent/blob/main/docs/SOYUZ_INTEGRATION.md).
- **Rusty-Fossil** is a Rust host-controller foundation for Soyuz Queue and callback contracts. Its production intake is disabled, it has no Docker or coding executor, and it has no repository checkout or GitHub publishing capability. It treats Queue input as untrusted and requires Soyuz claim and start proofs. See its [README](https://github.com/CyanAutomation/rusty-fossil/blob/main/README.md), [architecture](https://github.com/CyanAutomation/rusty-fossil/blob/main/docs/ARCHITECTURE.md), and [compatibility inventory](https://github.com/CyanAutomation/rusty-fossil/blob/main/docs/COMPATIBILITY.md).

Today, Kaseki's validation and GitHub publishing occur before Soyuz receives its completed callback. That callback may contain publishedUrl, but Soyuz has no separate publication record or publication state machine. Phase 0 does not change any of those systems or callback schemas.

The migration boundary is deliberate: future Kaseki and Rusty-Fossil execution paths upload the same executor-neutral manifest to Soyuz and hold no GitHub write credentials. Soyuz authorizes and dispatches the publication. Kirisame replaces Kaseki's repository shell, local Git commit/push, force-with-lease branch update and in-process PR retry loop with bounded Git Data API operations, deterministic create-only `kirisame/p/{publicationId}` refs, and read-before-retry reconciliation. Kirisame never force-updates or deletes a pre-existing branch; an unrelated ref is a conflict requiring a new authorization and publicationId.

## Trust boundaries

1. **Untrusted execution:** Generated code, repository files, executor output, and claims emitted from a disposable coding environment are untrusted. A success message or validationPassed flag alone grants no write authority.
2. **Validated but untrusted artifact:** The manifest remains untrusted input after a successful coding run. Soyuz binds it to its canonical run and current worker claim, validates trusted execution evidence, stores it immutably, and authorizes a specific publication. Kirisame still verifies the bytes, digest, paths, operation set and declared base.
3. **Trusted Soyuz control plane:** Soyuz reads its own canonical run and validation evidence, resolves publishMode, chooses the publicationId, locks the artifact to that run, and invokes only an allowed operation. Its Service Binding is the caller identity for the initial deployment.
4. **Kirisame publication service:** Kirisame accepts requests only through the configured private binding. It validates the complete v1 request, checks its independent repository allowlist and GitHub installation access, and applies its own ref, branch, artifact and token policies.
5. **GitHub:** GitHub is the authority for installed repositories, refs, commit objects, open or closed pull requests, and branch protections. A successful request from Soyuz does not override repository policy or GitHub rules.

The private Service Binding must be configured only on the Soyuz Worker. Kirisame has no public publishing route. Caller-supplied validation booleans, executor-supplied repository authorization, arbitrary artifact URLs, and arbitrary Git or GitHub operations are never accepted.

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
  S->>K: private binding: v1 request plus manifest and digest
  K->>K: validate contract, provenance, repository policy and manifest
  K->>G: read installation, target ref and base tree
  G-->>K: installation and expected base state
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

The target is one independent Worker with a private Service Binding. The initial runtime needs no public route, D1, KV, Queue, Durable Object, Workflow or new R2 resource. Soyuz remains the durable lifecycle owner. A Kirisame journal is not a Phase 0 or Phase 1 resource.

The artifact request is intentionally small and bounded: at most 5 MiB decoded file content, 100 paths, 1 MiB per file, and 8 MiB for canonical manifest JSON. This is a contract policy, not a Cloudflare limit. Cloudflare documents a 128 MiB isolate memory limit and recommends bounding or streaming bodies; request body caps at public Worker ingress depend on the zone plan. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).

## Decisions and follow-on work

The seven ADRs in [docs/adr](adr/0001-standalone-worker.md) record the service, caller, credentials, artifact, lifecycle, GitHub API and retry decisions. The cross-repository work required before publishing can be enabled is listed in [Soyuz integration](SOYUZ-INTEGRATION.md) and the [Phase 1 plan](PHASE1-PLAN.md).
