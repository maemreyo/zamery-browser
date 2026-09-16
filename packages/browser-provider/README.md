# @zamery/browser-provider

Provider-neutral TypeScript contracts for browser integrations.

This is the foundation package for Zamery Browser. It defines BrowserProvider V1 and the additive BrowserProvider V2 contract without depending on Pi, Firefox, Zamery Workbench, or any concrete automation engine.

## Install

```bash
npm install @zamery/browser-provider
```

## What it gives you

- A stable provider-neutral browser contract.
- Explicit browser/provider session identity.
- Freshness and provenance semantics for semantic snapshots.
- Declared vs observed action semantics.
- Validated action receipts that preserve ambiguous outcomes instead of converting them into success.
- Side-by-side V1/V2 contracts so protocol evolution is explicit.

## Example

```ts
import {
  BROWSER_PROVIDER_V2,
  type BrowserProviderV2,
} from "@zamery/browser-provider";

function acceptsV2(provider: BrowserProviderV2): boolean {
  return provider.protocolVersion === BROWSER_PROVIDER_V2;
}
```

A concrete provider can expose `createBrowserProvider(options)` for the stable V1 path and `createBrowserProviderV2(options)` for V2-aware consumers.

## Compatibility

- Node.js `>=22.19.0 <25`.
- BrowserProvider protocol revisions are separate from npm package semver.
- V1 remains available; V2 does not silently reinterpret V1 behavior.

## Related packages

- [`@zamery/pi-browser`](https://github.com/maemreyo/zamery-browser/tree/main/packages/pi-browser) — typed Pi browser tools backed by a BrowserProvider.
- [`@zamery/browser-firefox`](https://github.com/maemreyo/zamery-browser/tree/main/packages/browser-firefox) — Firefox implementation for an already-running browser.

## Versioning while 0.x

Patch releases preserve exported runtime/TypeScript semantics. Minor releases may add APIs. Intentional breaking API or semantic changes are called out with migration notes even before 1.0.

## License

Apache-2.0.
