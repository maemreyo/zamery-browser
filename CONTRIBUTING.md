# Contributing to Zamery Browser

Thank you for contributing to Zamery Browser. This repository contains the public source for the provider-neutral browser contracts, the Pi browser tools, the Firefox provider, and the standalone MCP server.

## Development requirements

- Node.js `>=22.19.0 <25`
- pnpm `10.20.0`

Fork the repository, create a focused branch from `main`, then install dependencies and run the public verification command:

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs the build, typecheck, Firefox tests, and MCP tests. Pull requests must keep it passing.

## Scope and compatibility

The project is still `0.x`. Additive API work may ship in a minor release. Existing protocol versions and documented outcome semantics should not be silently reinterpreted. If a change intentionally breaks an existing public contract, document the migration and versioning impact in the pull request.

When changing browser behavior, preserve the distinctions documented in the [security model](docs/security-model.md): authorization is not the same as process success, snapshot references are freshness-aware, action outcomes must preserve ambiguity, and the Firefox provider does not own the user's browser or tabs.

## Pull requests

Keep a pull request focused on one coherent change. Include:

- what changed and why;
- which public packages or contracts are affected;
- compatibility or security implications;
- documentation/example changes when behavior is user-visible;
- the verification commands you ran.

CI runs build, typecheck, and tests on every pull request and on `main`. `main` is protected: required CI must pass and review conversations must be resolved before merge.

## Issues

Use the bug report template for reproducible defects and the feature request template for new capabilities. Include package versions, Node.js version, provider/browser context, and the smallest useful reproduction when applicable.

Use GitHub Discussions for usage questions, design exploration, integration ideas that are not yet actionable feature requests, and general community help. See [SUPPORT.md](SUPPORT.md).

For suspected vulnerabilities, do not open a public issue. Follow [SECURITY.md](SECURITY.md) and use GitHub private vulnerability reporting.

## License

By contributing, you agree that your contributions will be licensed under the repository's Apache-2.0 license.

## Community conduct

Participation in issues, discussions, pull requests, reviews, and other project spaces is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
