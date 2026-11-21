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

Kirisame must explicitly validate base tree paths, file operations and commit ancestry. Git LFS, executable bits, symlinks, submodules and arbitrary Git features remain unsupported. The API is less flexible than full Git but substantially narrows authority.

References: [Git Trees API](https://docs.github.com/en/rest/git/trees), [Git Commits API](https://docs.github.com/en/rest/git/commits), [Git References API](https://docs.github.com/en/rest/git/refs), and [Pull Requests API](https://docs.github.com/en/rest/pulls/pulls).
