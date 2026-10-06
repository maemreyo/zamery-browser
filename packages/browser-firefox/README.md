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

## Optional interfaces

`FirefoxBrowserProviderV2` also implements, as separate versioned interfaces from `@zamery/browser-provider`:

- `BrowserAttentionProviderV1` — a bounded `requestAttention({ kind: "access" })` path that may raise a Firefox badge/optional notification but cannot grant or widen access.
- `BrowserAuthorizationProviderV1` — scope, expiry and restart status (`authorizationDetail`).
- `BrowserControlProviderV1` — claim, hand-off requests and `mutationStatus`.
- `BrowserTabProviderV1` — create/navigate/reload/activate/close-owned tabs.
- `BrowserTabGroupProviderV1` — Firefox tab groups (opaque handles; membership snapshot by default).
- `BrowserArtifactProviderV1` — bounded screenshots stored as short-lived, integrity-checked artifacts.

Use the structural guards (`isBrowserControlProviderV1`, …) before calling them. Options worth knowing: `audienceId` (a stable consumer id keeps a grant across your restarts), `clientLabel` (informational), `artifactRoot`.

Use `createFirefoxRequestId()` for mutation ids; the native host rejects ids older than its replay horizon and reconciles a lost response by id (`mutationStatus`).

## Setup and diagnostics

```bash
npx @zamery/browser-firefox setup --dry-run   # show what would be written
npx @zamery/browser-firefox setup             # install the Native Messaging host (never restarts Firefox)
npx @zamery/browser-firefox doctor            # non-mutating health report (--json for tools)
```

`doctor` only reports what it can observe (installed files, the profile's add-on registry entry for this add-on, a live status handshake). `setup` refuses to overwrite a different manifest unless `--force`, and then keeps a backup.

## Firefox companion

The Firefox path requires the Mozilla-signed **Zamery Browser Companion** and the local Native Messaging host. Stable companion `0.2.6` is public on AMO and is the accepted browser build for Zamery Browser `v0.2.4`.

The companion keeps attention separate from authority. Pre-auth access requests, credential hand-off, resume requests, origin confirmation and live rebind waits can raise a toolbar badge. OS notifications are optional and only enabled from an explicit popup gesture; notification clicks only focus Firefox/open the panel and never grant, Resume or confirm a site. The popup's **Manage access** action can only reduce an existing grant; expansion goes through the explicit Share flow.

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
- Optional browser-backed asset discovery/read keeps source URLs and credentials inside the provider while exposing only opaque refs and bounded transfer semantics to consumers.

## Compatibility

- Node.js `>=22.19.0 <25`; Firefox desktop 142 or newer (tab groups are feature-detected).
- `@zamery/browser-provider` at the matching package release.
- Native wire protocol 2: the host and companion must speak the same revision or every operation fails closed. `doctor` shows the observed pair.

## Related packages

- [`@zamery/browser-provider`](https://github.com/maemreyo/zamery-browser/tree/main/packages/browser-provider) — provider-neutral contracts.
- [`@zamery/pi-browser`](https://github.com/maemreyo/zamery-browser/tree/main/packages/pi-browser) — typed Pi browser tools.

## License

Apache-2.0.
