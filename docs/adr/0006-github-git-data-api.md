# ADR 0006: GitHub Git Data API instead of Git CLI

**Status:** Accepted

## Context

Kirisame must publish validated file changes without running code or commands derived from repository content. Its charter calls for bounded repository operations, not a remote shell.

## Decision

Use GitHub's REST Git Data API to read the base tree and create blobs, a tree and a commit. Create a deterministic feature reference only if absent. Use the Pull Requests API for PR mode. Do not spawn Git CLI, execute hooks/scripts, or run generic GitHub API proxy requests.

## Alternatives considered

- Run Git CLI against a repository checkout.
- Execute a caller-provided command or patch script.
- Use a generic GitHub API proxy.

## Reasons

The Git Data endpoints expose the exact bounded operations required, support installation tokens with Contents permission, and avoid a repository shell or execution environment. Pull request creation is separately constrained by the PR API.

## Consequences and trade-offs

Kirisame explicitly validates base tree paths, file operations and commit ancestry. The real adapter bounds responses and traversal, reads subtrees rather than trusting a recursive response, and rejects truncation or malformed object identities. Git LFS, executable bits, symlinks, submodules and arbitrary Git features remain unsupported. Artifact writes to `.gitattributes` are rejected; applicable base-tree filters are checked before writing. The API is less flexible than full Git but substantially narrows authority.

Phase 2A implements this interface with a fixed GitHub API origin/version, redirect denial, timeout and response bounds, blob SHA verification, create-only refs, bounded PR pagination, and structured permission/rate-limit/transient error handling. The implementation is covered through injected HTTP responses; it has not been activated against a live repository.

References: [Git Trees API](https://docs.github.com/en/rest/git/trees), [Git Commits API](https://docs.github.com/en/rest/git/commits), [Git References API](https://docs.github.com/en/rest/git/refs), and [Pull Requests API](https://docs.github.com/en/rest/pulls/pulls).
