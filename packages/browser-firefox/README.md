# @zamery/browser-firefox

Connect BrowserProvider to the Firefox session you already use.

`@zamery/browser-firefox` implements the Zamery BrowserProvider contract through a Native Messaging host and the Mozilla-signed Zamery Browser Companion. It targets an already-running Firefox instead of launching a disposable automation profile.

## Install

```bash
npm install @zamery/browser-firefox @zamery/browser-provider
```

## Provider usage

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

The package exports both V1 and V2 provider factories:

- `createBrowserProvider()` / `createFirefoxBrowserProvider()`
- `createBrowserProviderV2()` / `createFirefoxBrowserProviderV2()`

## Firefox companion

The Firefox path requires the Mozilla-signed **Zamery Browser Companion** and the local Native Messaging host. The companion is currently signed/unlisted rather than a searchable public AMO listing.

See the repository's [Firefox setup guide](https://github.com/maemreyo/zamery-browser/blob/main/docs/firefox-setup.md) for installation and authorization.

## Native Messaging host

```ts
import { installFirefoxNativeHost } from "@zamery/browser-firefox";

const plan = installFirefoxNativeHost({
  extensionId: "zamery-browser-firefox@zamery.local",
});

console.log(plan.manifestPath);
```

The current installer targets macOS Firefox Native Messaging locations. It writes the host runtime/manifest but does not launch, replace, or claim ownership of Firefox.

## Semantics that stay explicit

- Browser authorization is separate from process success.
- The user's browser/tabs remain user-owned.
- Snapshot refs are opaque and freshness-sensitive.
- Firefox actions are DOM-synthetic; they are not represented as trusted OS/browser input.
- Partial/unknown mutation outcomes are preserved rather than blindly retried.
- Restricted Firefox/internal pages can remain unavailable when content-script injection is blocked.

## Compatibility

- Node.js `>=22.19.0 <25`.
- `@zamery/browser-provider` at the matching package release.

## Related packages

- [`@zamery/browser-provider`](https://github.com/maemreyo/zamery-browser/tree/main/packages/browser-provider) — provider-neutral contracts.
- [`@zamery/pi-browser`](https://github.com/maemreyo/zamery-browser/tree/main/packages/pi-browser) — typed Pi browser tools.

## License

Apache-2.0.
