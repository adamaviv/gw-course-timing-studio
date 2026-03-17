# Security Policy

Thanks for helping keep **GW Course Studio** secure.

## Supported Versions

Security fixes are prioritized for:

| Version | Supported |
| --- | --- |
| `main` (latest) | :white_check_mark: |
| Current production deployment | :white_check_mark: |
| Older branches/releases | :x: |

If you are running an older version, please upgrade to the latest `main`/production release before reporting.

## Reporting a Vulnerability

Please **do not open public GitHub issues** for security vulnerabilities.

Preferred reporting method:

1. Go to this repository’s **Security** tab.
2. Use **Report a vulnerability** (GitHub private vulnerability reporting / advisory).
3. Include as much detail as possible (template below).

If private reporting is unavailable, contact the maintainers privately and include the same details.

## What to Include in a Report

Please include:

- A clear description of the issue and impact.
- Steps to reproduce (with exact requests, payloads, and expected vs actual behavior).
- Affected endpoint(s), file(s), and commit/branch if known.
- Proof of concept (minimal, safe, and non-destructive).
- Any mitigation ideas you already tested.

Helpful context for this repository:

- Node version used.
- Whether the issue appears in `development` and/or `production`.
- Relevant environment flags (for example: `ALLOWED_ORIGINS`, `TRUST_PROXY`, rate-limit settings).

## Response Timeline (Targets)

We aim to:

- Acknowledge report receipt within **3 business days**.
- Provide triage/severity decision within **7 business days**.
- Share remediation plan and ETA after triage.

Actual timelines can vary based on severity, complexity, and maintainer availability.

## Severity and Fix Prioritization

- **Critical/High**: expedited patch and coordinated release.
- **Medium**: patch in the next scheduled security/maintenance release.
- **Low**: may be bundled with routine hardening work.

## Coordinated Disclosure

Please allow time for a fix before public disclosure.

After a fix is released, we will coordinate on disclosure details (advisory, release notes, and any required credit).

## Safe Harbor

We support good-faith security research that:

- Avoids privacy violations, service disruption, and data destruction.
- Does not access or modify data beyond what is strictly necessary to demonstrate impact.
- Stops testing and reports promptly after discovering sensitive exposure.

Activities outside these boundaries may not be considered authorized.

## Out of Scope

The following are generally out of scope unless they show a direct exploit path in this codebase:

- Vulnerabilities in third-party services/platforms without repository-specific impact.
- Social engineering, phishing, or physical attacks.
- Purely theoretical issues without a reproducible technical impact.

## Thank You

We appreciate responsible disclosure and collaboration to protect users and maintainers.
