# ADR 0004: Immutable manifest over the private service interface

**Status:** Proposed

## Context

Current Soyuz stores generic executor artifacts in private R2 for 30 days. It does not yet store a publication-ready manifest or pin artifacts for a separate publication lifecycle. Current Cloudflare Workers have bounded per-isolate memory and request body limits depend on ingress plan.

## Decision

Define a structured immutable file-change manifest for UTF-8 additions, modifications and deletions. For the first implementation, Soyuz loads the verified manifest from R2 and sends it inline to Kirisame over the private Service Binding. Bound one decoded manifest to 5 MiB content, 100 files, 1 MiB per file, 8 MiB canonical manifest JSON and 9 MiB request body.

Soyuz must retain the artifact while publication is nonterminal and after terminal resolution for the documented recovery window. Phase 0 provisions no R2 resources.

## Alternatives considered

- Send an arbitrary public URL or a caller-provided URL for Kirisame to fetch.
- Bind Kirisame directly to the Soyuz R2 bucket.
- Add a Soyuz artifact-broker Worker with a read-only fetch operation.
- Send an unrestricted Git command, patch program or repository script.

## Reasons

Inline verified bytes avoid arbitrary URL fetching and avoid granting Kirisame an R2 capability. The strict cap is well below Cloudflare's published Worker request-size maxima and keeps memory use predictable. The manifest can be validated identically in TypeScript and Rust.

## Consequences and trade-offs

Soyuz and both executor paths must produce and retain the structured manifest. Larger artifacts require a new design. R2 direct binding is not selected because it gives Kirisame an unnecessary data capability; a broker remains an option if measured manifests exceed the limit. Current retention cleanup must become publication-aware before delayed retries are safe.

References: [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
