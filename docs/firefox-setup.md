# Firefox setup

`@zamery/browser-firefox` talks to an already-running Firefox through two pieces:

1. a Mozilla-signed **Zamery Browser Companion** WebExtension;
2. a local Native Messaging host installed by `@zamery/browser-firefox`.

The companion is currently signed/unlisted (self-distributed), not a searchable public AMO listing.

## 1. Install the signed companion

Use the signed `0.1.1` XPI from this repository's GitHub Release. Firefox may ask you to confirm the add-on installation and permissions.

Production extension ID:

```text
zamery-browser-firefox@zamery.local
```

The companion requests broad page access because it needs to inspect and act on user-selected web pages. Firefox/internal restricted pages can remain unavailable.

## 2. Install the Native Messaging host

Install the npm package first:

```bash
npm install @zamery/browser-firefox
```

Then install the host manifest for the signed production companion:

```bash
node --input-type=module <<'NODE'
import { installFirefoxNativeHost } from "@zamery/browser-firefox";

const plan = installFirefoxNativeHost({
  extensionId: "zamery-browser-firefox@zamery.local",
});

console.log(plan.manifestPath);
NODE
```

The current installer targets Firefox Native Messaging locations on macOS and places its runtime under the user's `~/Library/Application Support/Zamery/browser-firefox` directory. It does not launch or replace Firefox.

## 3. Authorize the live companion

Open the Zamery Browser Companion popup in Firefox and explicitly grant the live native-host session. Authorization is session-bound and is not inferred from a successful process launch.

## 4. Use the provider

```ts
import { createBrowserProviderV2 } from "@zamery/browser-firefox";

const provider = createBrowserProviderV2();
try {
  console.log(await provider.listInstances());
} finally {
  await provider.close();
}
```

Closing the provider cleans up the provider session; it does not mean the user's Firefox browser or tabs are owned by the provider.

## Troubleshooting

- No instances: check that the signed companion is installed, the Native Messaging host manifest exists, and the live session is authorized.
- Restricted context: some Firefox/internal pages refuse content-script injection; the provider reports those capabilities unavailable rather than pretending they work.
- Stale snapshot/action ref: take a fresh semantic snapshot instead of treating an old opaque ref as a permanent selector.
