// Runs the real companion background script inside a Node VM against a fake `browser` API.
// Tests drive it exactly like Firefox does: native-messaging port messages and popup runtime messages.
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const COMPANION_DIR = fileURLToPath(new URL("../../runtime/companion/", import.meta.url));
export const EXTENSION_ID = "zamery-browser-firefox@zamery.local";
export const POPUP_URL = "moz-extension://test/popup.html";

class Emitter {
  constructor() { this.listeners = []; }
  addListener(fn) { this.listeners.push(fn); }
  removeListener(fn) { this.listeners = this.listeners.filter((entry) => entry !== fn); }
  hasListener(fn) { return this.listeners.includes(fn); }
  async fire(...args) {
    const results = [];
    for (const fn of [...this.listeners]) results.push(await fn(...args));
    return results;
  }
}

export function createFakeBrowser(options = {}) {
  const storage = new Map(Object.entries(options.storage || {}));
  const tabs = new Map();
  const groups = new Map();
  const windows = new Map(Object.entries(options.windows || { 1: { id: 1, focused: true, incognito: false, type: "normal" } }).map(([k, v]) => [Number(k), v]));
  const nativeMessages = [];
  const contentCalls = [];
  // Each connectNative() call yields a fresh port, like Firefox; tests talk to whichever port is current.
  let currentPort = null;
  const nativeOnMessage = { fire: (...args) => (currentPort ? currentPort.onMessage.fire(...args) : Promise.resolve([])) };
  const nativeOnDisconnect = { fire: (...args) => (currentPort ? currentPort.onDisconnect.fire(...args) : Promise.resolve([])) };
  const events = {
    tabsOnRemoved: new Emitter(), tabsOnUpdated: new Emitter(), tabsOnActivated: new Emitter(),
    tabsOnCreated: new Emitter(), tabsOnMoved: new Emitter(), tabsOnAttached: new Emitter(),
    tabsOnDetached: new Emitter(), tabsOnReplaced: new Emitter(),
    windowsOnFocusChanged: new Emitter(), windowsOnRemoved: new Emitter(), windowsOnCreated: new Emitter(),
    groupsOnCreated: new Emitter(), groupsOnUpdated: new Emitter(), groupsOnMoved: new Emitter(), groupsOnRemoved: new Emitter(),
    runtimeOnMessage: new Emitter(), runtimeOnMessageExternal: new Emitter(),
    permissionsOnAdded: new Emitter(), permissionsOnRemoved: new Emitter(), notificationsOnClicked: new Emitter(),
  };
  let notificationPermission = options.notificationPermission === true;
  let nextTabId = 100;
  let nextGroupId = 500;
  const state = {
    // Page scripts, per tab id. A handler receives the message and returns the content-script response.
    contentHandlers: new Map(),
    captureResult: null,
    failures: new Map(),
    notifications: new Map(),
    notificationCreates: [],
    notificationUpdates: [],
    badgeText: "",
    browserActionTitle: "Zamery Browser",
    popupOpenCount: 0,
  };

  function addTab(tab) {
    const id = tab.id ?? nextTabId++;
    const full = {
      id, windowId: 1, active: false, incognito: false, url: "https://example.test/", title: "Example",
      pinned: false, groupId: -1, index: tabs.size, ...tab,
    };
    tabs.set(id, full);
    return full;
  }
  for (const tab of options.tabs || []) addTab(tab);

  function requireTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return tab;
  }
  const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

  const browser = {
    runtime: {
      id: EXTENSION_ID,
      lastError: null,
      getManifest: () => ({ version: "0.1.4-test", manifest_version: 2 }),
      getBrowserInfo: async () => ({ name: "Firefox", version: options.firefoxVersion ?? "157.0", buildID: "20260101000000" }),
      getURL: (name) => `moz-extension://test/${name}`,
      connectNative: () => {
        const port = {
          onMessage: new Emitter(),
          onDisconnect: new Emitter(),
          postMessage: (message) => {
            if (currentPort !== port) return;
            nativeMessages.push(clone(message));
            state.onNativePost?.(clone(message));
          },
          disconnect: () => port.onDisconnect.fire({}),
        };
        currentPort = port;
        state.connectCount = (state.connectCount || 0) + 1;
        return port;
      },
      onMessage: events.runtimeOnMessage,
      sendMessage: async () => undefined,
      reload: () => { state.reloaded = true; },
    },
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return Object.fromEntries(storage);
          const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
          const out = {};
          for (const key of list) if (storage.has(key)) out[key] = clone(storage.get(key));
          return out;
        },
        async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, clone(value)); },
        async remove(keys) { for (const key of [].concat(keys)) storage.delete(key); },
      },
    },
    permissions: {
      async contains(request) {
        return request?.permissions?.includes?.("notifications") ? notificationPermission : false;
      },
      async request(request) {
        if (!request?.permissions?.includes?.("notifications")) return false;
        if (options.notificationPermissionRequestResult === false) return false;
        notificationPermission = true;
        await events.permissionsOnAdded.fire({ permissions: ["notifications"], origins: [] });
        return true;
      },
      async remove(request) {
        if (!request?.permissions?.includes?.("notifications")) return false;
        const had = notificationPermission;
        notificationPermission = false;
        if (had) await events.permissionsOnRemoved.fire({ permissions: ["notifications"], origins: [] });
        return had;
      },
      onAdded: events.permissionsOnAdded,
      onRemoved: events.permissionsOnRemoved,
    },
    notifications: {
      async create(id, options) {
        const key = id || `notification-${state.notifications.size + 1}`;
        state.notifications.set(key, clone(options));
        state.notificationCreates.push({ id: key, options: clone(options) });
        return key;
      },
      async update(id, options) {
        if (!state.notifications.has(id)) return false;
        state.notifications.set(id, { ...state.notifications.get(id), ...clone(options) });
        state.notificationUpdates.push({ id, options: clone(options) });
        return true;
      },
      async clear(id) { return state.notifications.delete(id); },
      onClicked: events.notificationsOnClicked,
    },
    browserAction: {
      async setBadgeText({ text }) { state.badgeText = text; },
      async setTitle({ title }) { state.browserActionTitle = title; },
      async openPopup() {
        state.popupOpenCount += 1;
        if (state.failures.has("browserAction.openPopup")) throw new Error(state.failures.get("browserAction.openPopup"));
      },
    },
    tabs: {
      async get(tabId) { return clone(requireTab(tabId)); },
      async query(filter = {}) {
        let list = [...tabs.values()];
        if (filter.active !== undefined) list = list.filter((tab) => tab.active === filter.active);
        if (filter.windowId !== undefined) list = list.filter((tab) => tab.windowId === filter.windowId);
        if (filter.groupId !== undefined) list = list.filter((tab) => tab.groupId === filter.groupId);
        if (filter.currentWindow) list = list.filter((tab) => tab.windowId === 1);
        return clone(list.sort((a, b) => a.index - b.index));
      },
      async create(props = {}) {
        if (state.failures.has("tabs.create")) throw new Error(state.failures.get("tabs.create"));
        const windowId = props.windowId ?? 1;
        const win = windows.get(windowId);
        if (!win) throw new Error(`No window with id: ${windowId}`);
        const tab = addTab({ url: props.url || "about:blank", windowId, incognito: Boolean(win.incognito), active: props.active !== false });
        state.createdWith = clone(props);
        return clone(tab);
      },
      async remove(tabId) {
        requireTab(tabId);
        tabs.delete(tabId);
        await events.tabsOnRemoved.fire(tabId, { windowId: 1, isWindowClosing: false });
      },
      async update(tabId, props) {
        const tab = requireTab(tabId);
        if (props.url !== undefined) { tab.url = props.url; await events.tabsOnUpdated.fire(tabId, { url: props.url }, clone(tab)); }
        if (props.active === true) {
          for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
          tab.active = true;
          await events.tabsOnActivated.fire({ tabId, windowId: tab.windowId });
        }
        return clone(tab);
      },
      async reload(tabId) { requireTab(tabId); state.reloaded = tabId; },
      async sendMessage(tabId, message) {
        requireTab(tabId);
        contentCalls.push({ tabId, message: clone(message) });
        const handler = state.contentHandlers.get(tabId);
        if (!handler) throw new Error("Could not establish connection. Receiving end does not exist.");
        return handler(message, tabs.get(tabId));
      },
      async executeScript(tabId) { requireTab(tabId); },
      async captureTab(tabId, opts) {
        requireTab(tabId);
        state.captureCalls = [...(state.captureCalls || []), { tabId, opts: clone(opts) }];
        if (typeof state.captureFor === "function") return state.captureFor(opts);
        return state.captureResult ?? "data:image/png;base64,iVBORw0KGgo=";
      },
      async group({ tabIds, groupId, createProperties }) {
        const ids = [].concat(tabIds);
        let id = groupId;
        if (id === undefined) {
          id = nextGroupId++;
          const windowId = createProperties?.windowId ?? requireTab(ids[0]).windowId;
          groups.set(id, { id, windowId, title: "", color: "grey", collapsed: false });
          await events.groupsOnCreated.fire(clone(groups.get(id)));
        }
        for (const tabId of ids) {
          const tab = requireTab(tabId);
          const previous = tab.groupId;
          tab.groupId = id;
          tab.pinned = false;
          await events.tabsOnUpdated.fire(tabId, { groupId: id }, clone(tab));
          void previous;
        }
        return id;
      },
      async ungroup(tabIds) {
        for (const tabId of [].concat(tabIds)) {
          const tab = requireTab(tabId);
          const previous = tab.groupId;
          tab.groupId = -1;
          await events.tabsOnUpdated.fire(tabId, { groupId: -1 }, clone(tab));
          if (previous >= 0 && ![...tabs.values()].some((other) => other.groupId === previous)) {
            const group = groups.get(previous);
            groups.delete(previous);
            if (group) await events.groupsOnRemoved.fire(clone(group), { isWindowClosing: false });
          }
        }
      },
      onRemoved: events.tabsOnRemoved, onUpdated: events.tabsOnUpdated, onActivated: events.tabsOnActivated,
      onCreated: events.tabsOnCreated, onMoved: events.tabsOnMoved, onAttached: events.tabsOnAttached,
      onDetached: events.tabsOnDetached, onReplaced: events.tabsOnReplaced,
      TAB_ID_NONE: -1,
    },
    tabGroups: {
      async get(groupId) { const g = groups.get(groupId); if (!g) throw new Error(`No group with id: ${groupId}`); return clone(g); },
      async query(filter = {}) {
        let list = [...groups.values()];
        if (filter.windowId !== undefined) list = list.filter((g) => g.windowId === filter.windowId);
        return clone(list);
      },
      async update(groupId, props) {
        const g = groups.get(groupId);
        if (!g) throw new Error(`No group with id: ${groupId}`);
        Object.assign(g, props);
        await events.groupsOnUpdated.fire(clone(g));
        return clone(g);
      },
      async move(groupId, { windowId, index }) {
        const g = groups.get(groupId);
        if (!g) throw new Error(`No group with id: ${groupId}`);
        if (windowId !== undefined) g.windowId = windowId;
        await events.groupsOnMoved.fire(clone(g));
        void index;
        return clone(g);
      },
      onCreated: events.groupsOnCreated, onUpdated: events.groupsOnUpdated, onMoved: events.groupsOnMoved, onRemoved: events.groupsOnRemoved,
      TAB_GROUP_ID_NONE: -1,
    },
    windows: {
      async get(windowId) { const w = windows.get(windowId); if (!w) throw new Error(`No window with id: ${windowId}`); return clone(w); },
      async getLastFocused() { return clone([...windows.values()].find((w) => w.focused) || [...windows.values()][0]); },
      async getAll() { return clone([...windows.values()]); },
      async update(windowId, props) {
        const w = windows.get(windowId);
        if (props.focused) { for (const other of windows.values()) other.focused = false; w.focused = true; await events.windowsOnFocusChanged.fire(windowId); }
        return clone(w);
      },
      onFocusChanged: events.windowsOnFocusChanged, onRemoved: events.windowsOnRemoved, onCreated: events.windowsOnCreated,
      WINDOW_ID_NONE: -1,
    },
  };

  return { browser, storage, tabs, groups, windows, nativeMessages, contentCalls, nativeOnMessage, nativeOnDisconnect, events, state, addTab };
}

export async function loadCompanion(options = {}) {
  const fake = createFakeBrowser(options);
  options.beforeStart?.(fake);
  const manifest = JSON.parse(fs.readFileSync(COMPANION_DIR + (options.manifest || "manifest.json"), "utf8"));
  const files = options.scripts || manifest.background.scripts;
  const sandbox = {
    browser: fake.browser,
    console: { error() {}, log() {}, warn() {} },
    crypto: crypto.webcrypto,
    TextEncoder, TextDecoder, URL, performance, setTimeout, clearTimeout, setInterval: (fn, ms) => setInterval(fn, ms).unref(), clearInterval,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    Promise, JSON, Date, Math, Set, Map, WeakMap, Error, Uint8Array, Number, String, Array, Object, Reflect, Symbol,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of files) {
    if (!fs.existsSync(COMPANION_DIR + file)) continue;
    vm.runInContext(fs.readFileSync(COMPANION_DIR + file, "utf8"), context, { filename: file });
  }
  await settle(30);
  const companion = {
    ...fake,
    context,
    sandbox,
    /** Deliver the native host's host_status so the companion binds to a host session. */
    async hostStatus({ sessionId = "host-session-1", protocol = 2 } = {}) {
      await fake.nativeOnMessage.fire({ type: "host_status", protocol_version: protocol, host_session_id: sessionId });
      await settle();
    },
    /** Send a broker request through the native port; resolves with the companion's posted response. */
    async request(message, { timeoutMs = 2_000 } = {}) {
      const before = fake.nativeMessages.length;
      const id = message.id;
      await fake.nativeOnMessage.fire({ type: "request", ...message });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = fake.nativeMessages.slice(before).find((entry) => entry.type === "response" && entry.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`no response for ${message.op} ${id}`);
    },
    /** Send a message the way the popup does. */
    async popup(message) {
      const results = await fake.events.runtimeOnMessage.fire(message, { id: EXTENSION_ID, url: POPUP_URL });
      return results.find((result) => result !== undefined);
    },
    async nonPopup(message, sender = { id: "other-extension@example" }) {
      const results = await fake.events.runtimeOnMessage.fire(message, sender);
      return results.find((result) => result !== undefined);
    },
  };
  return companion;
}

export function settle(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A permissive page-script stand-in: acknowledges ping/snapshot/act like content.js would. */
export function pageScript({ documentId = "doc-1", snapshotNodes = [], onAct } = {}) {
  const page = { documentId, acts: [], interactionGeneration: 0 };
  page.handler = async (message, tab) => {
    if (message.type === "zamery_browser_firefox_ping") {
      return { document_id: page.documentId, browser_document_id: null, url: tab.url, title: tab.title, viewport_width: 800, viewport_height: 600, interaction_generation: page.interactionGeneration, asset_discovery_v1_ready: false, asset_transfer_v1_ready: false };
    }
    if (message.type === "zamery_browser_firefox_snapshot") {
      return { document_id: page.documentId, browser_document_id: null, url: tab.url, title: tab.title, interaction_generation: page.interactionGeneration, nodes: snapshotNodes };
    }
    if (message.type === "zamery_browser_firefox_act") {
      page.acts.push(message);
      return onAct ? onAct(message) : { ok: true, mechanism: "dom-synthetic", observed_is_trusted: false };
    }
    return undefined;
  };
  return page;
}
