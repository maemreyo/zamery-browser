# Security Policy

## Supported versions

Zamery Browser is currently a `0.x` project. Security fixes are made against the latest published minor line unless a release note explicitly says otherwise.

| Version | Supported |
| --- | --- |
| `0.2.x` | Yes |
| `< 0.2.0` | No |

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository: open the repository's **Security** tab and choose **Report a vulnerability**. Include the affected package and version, the security boundary involved, reproduction steps or a minimal proof of concept when safe to share, and the impact you believe is possible.

The maintainers will triage the report, ask for additional evidence if needed, and coordinate disclosure and remediation through the private advisory.

## Security model

Before reporting behavior that may be an intentional boundary, review [docs/security-model.md](docs/security-model.md). In particular, Zamery Browser distinguishes browser authorization, provider capabilities, DOM-synthetic actions, opaque snapshot references, browser-owned assets, and ownership of the user's browser/session.
