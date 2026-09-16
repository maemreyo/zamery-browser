# Architecture

Zamery Browser separates the agent-facing tools from concrete browser integrations.

```text
Pi / agent
  |
  | typed tools
  v
@zamery/pi-browser
  |
  | BrowserProvider contract
  v
@zamery/browser-provider
  ^
  |
  | implementation
@zamery/browser-firefox
  |
  | Native Messaging
  v
Firefox companion -> existing Firefox
```

## Package boundaries

### `@zamery/browser-provider`

Defines provider-neutral contracts. It has no runtime dependency on Pi, Firefox, or Zamery Workbench.

BrowserProvider V1 is the stable contract used by the four current Pi browser tools. BrowserProvider V2 adds explicit provider-session identity, ownership/freshness provenance, declared-versus-observed action semantics, and validated action receipts.

### `@zamery/pi-browser`

Adapts a configured BrowserProvider into typed Pi tools. It loads the concrete provider module dynamically, so the tool package does not import Firefox directly.

Direct Pi hosts use `createPiBrowserExtension()`. Hosts with their own lifecycle/resource ownership can use the exported Zamery-compatible adapter/resources without requiring Zamery Workbench as a runtime dependency.

### `@zamery/browser-firefox`

Implements BrowserProvider for the user's already-running Firefox. It exposes provider factories and Native Messaging host installation APIs while keeping broker/session transport internals private.

## Ownership model

The browser is user-owned. A provider can observe and act only through the capabilities/authorization available to its live session. Closing the provider is not equivalent to closing Firefox.

## Playwright

This repository does not ship a `@zamery/browser-playwright` wrapper. Project-owned Playwright remains a native path when Playwright is the right tool; Zamery Browser does not duplicate Playwright's locator, auto-wait, trace, or test-runner semantics.
