# Examples

These examples are intentionally small and show package boundaries rather than hiding setup behind a framework.

- [`provider-contract.ts`](provider-contract.ts): consume BrowserProvider V2 types without a concrete browser dependency.
- [`pi-extension.ts`](pi-extension.ts): create the Pi browser extension with a dynamically selected provider module.
- [`firefox-native-host.mjs`](firefox-native-host.mjs): install the Native Messaging host for the signed Firefox companion.

For a real Firefox session, install/authorize the signed companion first; see [`docs/firefox-setup.md`](../docs/firefox-setup.md).
