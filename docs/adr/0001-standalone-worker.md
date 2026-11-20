# ADR 0001: Standalone Cloudflare Worker

**Status:** Accepted

## Context

Kirisame's charter defines a focused GitHub publication boundary with its own repository and deployment lifecycle. It must remain independent from coding executors and the Soyuz control plane.

## Decision

Build Kirisame as a standalone Cloudflare Worker repository. Soyuz is its initial private Service Binding client. Kirisame has no MCP/UTCP interface, public publishing route, coding runtime or repository shell.

## Alternatives considered

- Put GitHub code in Soyuz, which would combine orchestration and GitHub authority.
- Leave GitHub write authority in each executor, which distributes long-lived credentials into coding environments.
- Expose an agent-facing protocol or public endpoint, which is not needed for the trusted control-plane integration.

## Reasons

This follows the existing README's ownership and least-privilege principles and permits independent deploy and rollback.

## Consequences and trade-offs

There is one additional service deployment and a versioned cross-repository contract. Soyuz must manage its caller lifecycle and compatibility. The boundary reduces credential exposure and keeps Kirisame's scope narrow.
