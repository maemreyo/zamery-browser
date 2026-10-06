// Full-stack harness: real FirefoxBrowserProviderV2 -> real UDS broker -> real native-host.mjs process
// -> Native Messaging framing -> real companion background script (in a VM) -> fake Firefox APIs.
import { FakeFirefox, makeTempRoot } from "./native-host-harness.mjs";
import { loadCompanion, pageScript, settle } from "./companion-harness.mjs";

export const NODE = { node_id: "n1", role: "button", name: "Go", tag: "button" };

export async function startStack({ tabs, windows, profileId = "profile-stack", storage, roots, pages: pageOverrides } = {}) {
  const rootDirs = roots ?? makeTempRoot();
  const host = new FakeFirefox({ roots: rootDirs, profileId, handler: async () => null });
  // Bridge mode: skip the scripted hello; the real companion announces itself.
  host.hello = () => {};
  host.waitForSession = async () => undefined;
  await host.start();
  const company = await loadCompanion({
    tabs: tabs ?? [
      { id: 1, url: "https://a.test/page", title: "Shared page", active: true },
      { id: 2, url: "https://b.test/secret", title: "Private page", active: false },
    ],
    windows,
    storage,
    beforeStart: (fake) => {
      fake.state.onNativePost = (message) => host.send(message);
    },
  });
  const pages = {};
  for (const tab of company.tabs.values()) {
    pages[tab.id] = pageOverrides?.[tab.id] ?? pageScript({ snapshotNodes: [NODE] });
    company.state.contentHandlers.set(tab.id, pages[tab.id].handler);
  }
  // Host -> companion: requests, cancels, host_status.
  host.onMessage = (message) => { void company.nativeOnMessage.fire(message); };
  await company.nativeOnMessage.fire(host.hostStatusMessage);
  await host.waitForSessionReal();
  await settle(30);
  return {
    host,
    company,
    pages,
    session: () => host.session(),
    roots: rootDirs,
    async stop() { await host.kill(); rootDirs.cleanup(); },
  };
}
