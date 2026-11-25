# Publication artifacts

## Contract and supported changes

The canonical v1 manifest is [publication-artifact.schema.json](../contracts/v1/publication-artifact.schema.json). A manifest is immutable and contains a Soyuz artifact ID, canonical run UUID, explicit GitHub owner/repository, base ref and base commit SHA, file count, decoded byte total, and deterministically ordered file changes.

Initial operations are:

| Operation | Required content | Base expectation |
| --- | --- | --- |
| add | UTF-8 text bytes and SHA-256 | Path does not exist at baseSha. |
| modify | UTF-8 text bytes, SHA-256 and base blob SHA | Path exists and its base blob SHA matches. |
| delete | Base blob SHA | Path exists and its base blob SHA matches. |

A rename is represented as a delete at the old path plus an add at the new path. The pair has no rename metadata. Empty manifests are rejected.

Files always use Git mode 100644. The v1 contract does not support binary blobs, invalid UTF-8, symlinks, submodules/gitlinks, Git LFS objects, executable-mode changes, arbitrary tree modes, Git hooks, patch application, or repository shell scripts. Kirisame must return an explicit ARTIFACT_INVALID or policy error when it sees unsupported input; it must never omit an unsupported entry and publish the rest. All artifact changes to root or nested `.gitattributes` files are rejected. Before writing Git objects, Kirisame reads the pinned base tree's root and applicable nested attribute files. It rejects a changed file if a supported rule applies an active filter, and fails closed on active filters, `working-tree-encoding`, unsupported pattern syntax, or malformed/over-limit attribute data. Rules are interpreted from the pinned base commit only; the artifact cannot alter the rules in the same publication.

## Bounds

The v1 limits are contract policy:

| Resource | Limit |
| --- | ---: |
| File changes per manifest | 1–100 |
| One decoded file | 1 MiB |
| Total decoded content | 5 MiB |
| UTF-8 repository path | 1,024 bytes |
| Canonical JSON manifest | 8 MiB |
| Complete publication request body | 9 MiB |
| PR title | 200 characters |
| PR body | 10,000 characters |

The base64 representation expands content, which is why the encoded manifest limit is larger than the decoded data limit. Worker request parsing must enforce the raw body cap before buffering or parsing JSON. These ceilings are deliberately below Cloudflare's published ingress maxima and keep memory use bounded. A later size increase requires a measured Worker memory and CPU test and a contract revision.

Soyuz accepts generic artifacts separately from publication manifests. The v1 publication manifest uses the stricter bounds above and is uploaded through the dedicated claim-fenced route. Kaseki source now includes the trusted host producer: it constructs one bounded manifest from the workspace pinned to the resolved base SHA. The producer feature remains disabled until that source is rolled out to the trusted execution host.

## Path and operation validation

Paths are UTF-8 NFC normalized, slash-separated repository-relative paths. Reject absolute paths, empty components, dot and dot-dot components, backslashes, drive separators, control characters, NUL, any .git path component (case-insensitive), paths longer than 1,024 UTF-8 bytes, and paths that cannot be represented by the GitHub Git Data API. Do not URL-decode paths before validation.

Reject exact duplicate paths, case-folded collisions, and a file path that is also an ancestor directory of another changed path. Require files to be sorted by unsigned UTF-8 byte order. Enforce one operation for each path. These semantic rules supplement the JSON Schema, which enforces field allowlists and basic syntax.

Before writing Git objects, Kirisame reads the current base ref and requires its object SHA to equal baseSha. It reads the base tree and checks each operation: add requires an absent path; modify and delete require the declared baseBlobSha. Any mismatch fails closed. After applying changes in memory, it compares the complete expected leaf tree to the pinned base tree and returns `NO_CHANGES` when the result is identical, before creating blobs, trees, commits, or refs. The base repository, baseRef and baseSha in the artifact must exactly equal the corresponding request values.

## Content integrity and canonical digest

Each non-deletion content value uses canonical RFC 4648 padded base64. Decode strictly; re-encoding the bytes must produce the identical data string. The decoded value must be valid UTF-8 and contain no NUL, C0 control other than TAB, LF or CR, or DEL. Kirisame preserves the original UTF-8 bytes exactly; it does not normalize line endings, strip a BOM, or normalize file content.

For each content entry, sha256 is the lower-case hexadecimal SHA-256 of the decoded raw bytes. The artifactDigest field is the literal string sha256: followed by the lower-case hexadecimal SHA-256 of the RFC 8785 JSON Canonicalization Scheme UTF-8 bytes of the complete artifact object. The artifact object has no digest field, so there is no self-reference. RFC 8785 sorts object keys and preserves array order; file order is therefore independently fixed above. Implementations must use a conforming JCS implementation and must not substitute ordinary JSON.stringify, language-default map ordering, or pretty-printed JSON.

Kirisame verifies both the per-file digest and artifactDigest. It also verifies artifactId/runId provenance against the authorized Soyuz request. A digest proves integrity, not authorization or validation.

## Transport and retention decision

**Preferred for the first implementation:** Soyuz loads a verified, immutable manifest from its private R2 store and sends the manifest inline with the publication request over the private Service Binding.

This keeps the artifact reference non-addressable outside the trusted control plane, avoids a public URL or a caller-selected storage location, and lets Soyuz prove that the bytes belong to the canonical run before dispatch. Kirisame needs no R2 capability or storage credentials. The 9 MiB application request ceiling is stricter than Cloudflare's public ingress caps and is a deliberate memory bound.

**Alternative considered:** Kirisame receives an artifact ID and reads from Soyuz's R2 bucket through a narrow read-only service. A direct R2 Worker binding exposes the R2 API to the bound Worker; the binding itself is not the application-level read-only interface. A separate Soyuz artifact broker could expose a single authenticated read operation, but adds a second Worker call, authorization protocol, availability dependency and rollout ordering. That design is justified only if manifests exceed the inline cap.

Soyuz retains a publication manifest independently of generic run artifact expiry and run culling. Authorized intents, pending publications, active attempts, retryable failures, and blocked records remain pinned; after publication, the manifest remains for at least 30 days. Production migration `0009` is applied. The exact retention and cleanup behavior is implemented in [Soyuz's publication lifecycle](https://github.com/CyanAutomation/soyuz/blob/main/src/publication/lifecycle.ts).

Cloudflare documents Service Bindings as private Worker-to-Worker calls and documents 128 MiB Worker isolate memory with a recommendation to bound and stream bodies. The selected limit is an application policy rather than a claim about a Service Binding transport cap: [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
