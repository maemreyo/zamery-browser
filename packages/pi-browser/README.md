# @zamery/pi-browser

Typed browser tools for Pi, backed by a pluggable BrowserProvider.

`@zamery/pi-browser` exposes a small, explicit browser tool surface without hard-coding Firefox or another concrete browser implementation into the agent layer.

## Install

```bash
npm install @zamery/pi-browser @zamery/browser-provider
```

For the Firefox provider:

```bash
npm install @zamery/browser-firefox
```

## Stable tools

- `browser_status`
- `browser_contexts`
- `browser_snapshot`
- `browser_act`

The tools preserve provider capability and mutation semantics. An unknown or partial action outcome is not converted into success or blindly retried.

## Configuration

```json
{
  "provider_module": "@zamery/browser-firefox",
  "browser_instance_id": "optional-explicit-instance-id"
}
```

`provider_module` must resolve to a module exporting `createBrowserProvider(options)` for the current stable V1 tool path.

## Direct Pi usage

```ts
import { createPiBrowserExtension } from "@zamery/pi-browser";

const extension = createPiBrowserExtension({
  workspaceRoot: process.cwd(),
  config: {
    provider_module: "@zamery/browser-firefox",
  },
});

void extension;
```

Direct Pi hosts own cleanup through Pi's `session_shutdown` lifecycle. Hosts that manage resources separately can use the exported Zamery-compatible adapter/resources rather than importing Zamery Workbench.

## V2 helpers

Advanced consumers can use `loadBrowserProviderV2Factory()` and `createBrowserProviderV2Binding()` with provider modules that export `createBrowserProviderV2(options)`.

The stable four-tool Pi surface remains V1 until an explicit migration is designed and documented; V2 support is additive rather than a silent behavior change.

## Compatibility

- Node.js `>=22.19.0 <25`.
- Pi peer: `@earendil-works/pi-coding-agent@0.85.1`.
- Provider contract: `@zamery/browser-provider` at the matching package release.

The Pi peer is intentionally exact until compatibility with another version is proven.

## Related packages

- [`@zamery/browser-provider`](https://github.com/maemreyo/zamery-browser/tree/main/packages/browser-provider) — provider-neutral contracts.
- [`@zamery/browser-firefox`](https://github.com/maemreyo/zamery-browser/tree/main/packages/browser-firefox) — live Firefox provider.

## License

Apache-2.0.
