# ADR 0003: GitHub App credentials stay in Kirisame

**Status:** Accepted

## Context

The existing Kirisame App is intended for machine-to-machine GitHub publication. Coding hosts currently contain GitHub App settings for Kaseki's publisher, and that is the responsibility to migrate.

## Decision

Kirisame uses the dedicated GitHub App, numeric App ID 3345400, GitHub App JWT authentication and short-lived installation access tokens. The private key is stored only in trusted Kirisame Worker secret configuration. Do not use a personal access token or GitHub user OAuth.

Initial permissions are Metadata read, Contents read/write and Pull requests read/write. Installation tokens are restricted to the exact authorized repository and minimum permissions required.

## Alternatives considered

- Keep a personal access token in executor configuration.
- Share the App private key across Soyuz and executors.
- Authenticate as a GitHub user with OAuth.

## Reasons

This follows the Kirisame charter and separates app identity from execution. GitHub supports installation tokens scoped to selected repositories and permissions, with a one-hour expiration.

## Consequences and trade-offs

Kirisame will handle key rotation, token issuance and safe redaction. App installation and the Kirisame allowlist remain separate gates. No credential generation, rotation, installation or configuration change is part of the Phase 0.1/Phase 1 foundation.

References: [GitHub App permission guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) and [installation token guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
