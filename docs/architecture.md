# Architecture

Zamery Browser separates the agent-facing tools from concrete browser integrations.

```text
Pi / agent                         Codex / any local MCP host
  |                                   |
  | typed tools                       | stdio MCP
  v                                   v
@zamery/pi-browser                @zamery/browser-mcp
  |                                   |
  +---------- BrowserProvider V2 + optional interfaces ----------+
                                  |
                       @zamery/browser-provider (contracts)
                                  ^
                                  | implementation
                       @zamery/browser-firefox
                                  |
                                  | UDS broker -> Native Messaging host
                                  v
                    Firefox companion -> the user's existing Firefox
```

## Package boundaries

### `@zamery/browser-provider`

Defines provider-neutral contracts. It has no runtime dependency on Pi, Firefox, or Zamery Workbench.

BrowserProvider V2 stays the core contract. New capabilities are separate, independently versioned optional interfaces with structural type guards: `BrowserAuthorizationProviderV1` (scope/expiry/restart status), `BrowserControlProviderV1` (claim, hand-off, mutation status), `BrowserTabProviderV1`, `BrowserTabGroupProviderV1` and `BrowserArtifactProviderV1` (bounded screenshots). The protocol versions of these interfaces, the Firefox native wire revision, package semver, companion version and MCP protocol are all different numbers on purpose.

BrowserProvider V1 is the stable contract used by the four current Pi browser tools. BrowserProvider V2 adds explicit provider-session identity, ownership/freshness provenance, declared-versus-observed action semantics, and validated action receipts.

### `@zamery/pi-browser`

Adapts a configured BrowserProvider into typed Pi tools. It loads the concrete provider module dynamically, so the tool package does not import Firefox directly.

Direct Pi hosts use `createPiBrowserExtension()`. Hosts with their own lifecycle/resource ownership can use the exported Zamery-compatible adapter/resources without requiring Zamery Workbench as a runtime dependency.

### `@zamery/browser-mcp`

A standalone stdio MCP server over BrowserProvider V2 and the optional interfaces. It does not depend on Pi or Zamery Workbench, exposes no JavaScript/eval, and cannot grant itself access.

### `@zamery/browser-firefox`

Implements BrowserProvider for the user's already-running Firefox. It exposes provider factories and Native Messaging host installation APIs while keeping broker/session transport internals private.

## Ownership model

The browser is user-owned. A provider can observe and act only through the capabilities/authorization available to its live session. Closing the provider is not equivalent to closing Firefox.

## Playwright

This repository does not ship a `@zamery/browser-playwright` wrapper. Project-owned Playwright remains a native path when Playwright is the right tool; Zamery Browser does not duplicate Playwright's locator, auto-wait, trace, or test-runner semantics.

## Authority model (Firefox)

```text
ConsentGrant  (what the user approved, for how long; survives restarts if fixed-duration)
LiveBinding   (consent + concrete tabs/groups + host session + audience; dies on any restart)
Control       (no_access | shared_idle | agent_claimed | user_control | rebinding)
```

The companion is the policy engine. The provider and MCP layers improve clarity but cannot widen what the companion allows. See [Security model](security-model.md).
