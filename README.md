# Zamery Browser

Typed browser control for AI agents, built around explicit capabilities, semantic snapshots, and observable action outcomes.

Zamery Browser lets an agent work with a browser through a provider-neutral contract instead of coupling the agent to one automation engine. The Firefox provider connects to the user's already-running Firefox rather than launching a disposable browser profile.

## Install

```bash
npm install @zamery/browser-provider @zamery/pi-browser @zamery/browser-firefox
```

Node.js `>=22.19.0 <25` is currently supported. `@zamery/pi-browser` is tested against `@earendil-works/pi-coding-agent@0.85.1`.

## Packages

| Package | Purpose |
| --- | --- |
| `@zamery/browser-provider` | Provider-neutral BrowserProvider V1/V2 contracts, plus optional bounded browser-asset contracts. |
| `@zamery/pi-browser` | Typed Pi tools for status, contexts, semantic snapshots, browser-backed assets, and actions. |
| `@zamery/browser-firefox` | Firefox provider and Native Messaging host for an already-running Firefox session. |

## Architecture

```text
AI / Pi agent
     |
@zamery/pi-browser
     |
BrowserProvider contract
     |
@zamery/browser-firefox
     |
Native Messaging + signed companion
     |
Your existing Firefox
```

The provider contract is intentionally separate from the Firefox implementation. Another browser/provider can implement the same contract without changing the agent-facing tool layer.

## Quick example

```ts
import { createBrowserProviderV2 } from "@zamery/browser-firefox";

const provider = createBrowserProviderV2();
try {
  const instances = await provider.listInstances();
  console.log(instances);
} finally {
  await provider.close();
}
```

For Pi integrations, `@zamery/pi-browser` exposes `browser_status`, `browser_contexts`, `browser_snapshot`, `browser_assets`, and `browser_act`. `browser_assets` returns opaque refs and safe metadata rather than source URLs or browser credentials.

## Why this exists

Browser automation often hides important distinctions: whether the browser is user-owned, whether an action really happened, whether a DOM reference is still fresh, or whether a timeout occurred before or after mutation began. Zamery Browser keeps those boundaries explicit.

- The provider does not treat process success as browser authorization.
- Semantic snapshot refs are opaque and freshness-aware; they are not advertised as durable selectors.
- Actions preserve exact `completed`, `not_started`, `partial`, or `unknown` outcomes instead of converting ambiguity into success.
- Firefox actions are DOM-synthetic and are not represented as trusted OS input.
- Provider teardown does not imply ownership of the user's browser or tabs.
- Browser-backed asset discovery/transfer keeps sensitive source URLs and credentials provider-internal while exposing bounded opaque-ref workflows to consumers.

## Firefox companion

The Firefox path uses a Mozilla-signed Zamery Browser Companion plus a Native Messaging host. The companion is currently distributed as a signed, unlisted add-on rather than a public AMO listing. See [Firefox setup](docs/firefox-setup.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Firefox setup](docs/firefox-setup.md)
- [Security model](docs/security-model.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Examples](examples/README.md)

## Project status

The npm packages are public under the `@zamery` scope and licensed under Apache-2.0. The API is still `0.x`: additive work can land in minor releases, while intentional breaking changes are documented with migration notes rather than silently reinterpreting an existing protocol version.

## License

Apache-2.0. Each package includes its own license file; the repository root license applies to the repository as a whole.
