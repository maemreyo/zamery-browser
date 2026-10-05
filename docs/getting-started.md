# Getting started

## Install

```bash
npm install @zamery/browser-provider @zamery/pi-browser @zamery/browser-firefox
```

Current compatibility:

- Node.js `>=22.19.0 <25`
- `@earendil-works/pi-coding-agent@0.85.1` for `@zamery/pi-browser`

## Use the provider directly

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

The Firefox provider expects the Zamery Native Messaging host and signed companion to be installed and authorized. See [Firefox setup](firefox-setup.md).

## Use the Pi extension

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

The stable Pi tool surface is:

- `browser_status`
- `browser_contexts`
- `browser_snapshot`
- `browser_act`

The tools use BrowserProvider V1 semantics today. BrowserProvider V2 is available through explicit V2 factories/bindings rather than silently changing the meaning of the V1 tools.

## Use it from Codex (MCP)

```bash
codex mcp add zamery-firefox -- npx -y @zamery/browser-mcp@<tested-version>
```

Not available until a preview release candidate is published; see [technical preview status](technical-preview.md). In Firefox you then share tabs from the Zamery Browser panel; the agent cannot do that for itself.

Pi note: each Pi process appears as its own "Local agent" in the panel (its `clientId` is the audience), so a grant covers that process's session.

## Build this repository

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test          # unit, contract, integration and full-stack suites (no Firefox needed)
```

Live Firefox acceptance (isolated temp profile; adds then removes one native-messaging manifest named `com.zamery.browser_firefox_acceptance`): `pnpm --filter @zamery/browser-mcp live`.

This public repository contains only the reusable browser SDK packages and public documentation/examples; it does not depend on Zamery Workbench at runtime.
