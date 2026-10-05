import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadCompanion, pageScript, settle } from "./helpers/companion-harness.mjs";

const AUD = "audience-groups-aaaa";
let sequence = 0;
const rid = (prefix = "g") => `${prefix}-${++sequence}`;
const NODE = { node_id: "n1", role: "button", name: "Go", tag: "button" };
const ACTIONS = ["inspect", "interact", "capture", "reorganize", "create_tab", "close_owned_tab"];

/**
 * Window 1 layout: tabs 1,2 (shared), 5 (restricted page) all in native group 9 "Work";
 * tab 3 ungrouped and not shared; tab 7 pinned and shared directly.
 */
async function boot({ groupPolicy, grantGroups = [9], grantTabs = [], actions = ACTIONS, noGroupsApi = false, duration } = {}) {
  const tabs = [
    { id: 1, url: "https://a.test/1", title: "One", active: true, groupId: 9, index: 0 },
    { id: 2, url: "https://b.test/2", title: "Two", groupId: 9, index: 1 },
    { id: 5, url: "about:preferences", title: "Prefs", groupId: 9, index: 2 },
    { id: 3, url: "https://c.test/3", title: "Unshared secret", groupId: -1, index: 3 },
    { id: 7, url: "https://d.test/7", title: "Pinned", pinned: true, groupId: -1, index: 4 },
  ];
  const c = await loadCompanion({ tabs });
  if (noGroupsApi) delete c.browser.tabGroups;
  c.groups.set(9, { id: 9, windowId: 1, title: "Work", color: "blue", collapsed: false });
  const pages = {};
  for (const tab of c.tabs.values()) { pages[tab.id] = pageScript({ snapshotNodes: [NODE] }); c.state.contentHandlers.set(tab.id, pages[tab.id].handler); }
  await c.hostStatus();
  await c.request({ id: rid(), op: "status", audience_id: AUD, params: {} });
  const granted = await c.popup({
    type: "zamery_browser_firefox_grant", audience_id: AUD, actions, duration: duration ?? { mode: "session" },
    group_ids: grantGroups, tab_ids: grantTabs, group_policy: groupPolicy,
  });
  const ask = (op, params = {}) => c.request({ id: rid(op), op, audience_id: AUD, params });
  return { c, ask, pages, granted };
}

const popupStatus = (c) => c.popup({ type: "zamery_browser_firefox_auth_status" });

describe("group grant and read (membership_snapshot is the default)", () => {
  it("shares only the eligible members of the selected group and reports incomplete membership without leaking the rest", async () => {
    const { c, ask, granted } = await boot();
    assert.equal(granted.ok, true, JSON.stringify(granted));
    assert.equal(granted.scope_kind, "group");
    assert.equal(granted.group_policy, "membership_snapshot");
    const list = await ask("group_list");
    assert.equal(list.ok, true, JSON.stringify(list));
    assert.equal(list.result.groups.length, 1);
    const [group] = list.result.groups;
    assert.match(group.handle, /^grp_[a-f0-9]{20}$/);
    assert.deepEqual(group.member_context_ids.sort(), ["tab:1", "tab:2"]);
    assert.equal(group.incomplete_membership, true, "restricted tab 5 is a member the agent cannot see");
    assert.equal(group.title, "Work");
    assert.ok(!JSON.stringify(list).includes("Prefs") && !JSON.stringify(list).includes("about:preferences"));
    const contexts = await ask("list_contexts");
    assert.deepEqual(contexts.result.contexts.map((x) => x.context_id).sort(), ["tab:1", "tab:2"]);
    assert.equal((await ask("snapshot", { context_id: "tab:3" })).error.reason, "outside_scope");
    void c;
  });

  it("does not use numeric group ids or titles as handles", async () => {
    const { ask } = await boot();
    const attempt = await ask("group_get", { handle: "9" });
    assert.equal(attempt.error.reason, "outside_scope");
    const byTitle = await ask("group_get", { handle: "Work" });
    assert.equal(byTitle.error.reason, "outside_scope");
  });

  it("a tab that joins the group later is not shared in snapshot mode", async () => {
    const { c, ask } = await boot();
    c.tabs.get(3).groupId = 9;
    await c.events.tabsOnUpdated.fire(3, { groupId: 9 }, c.tabs.get(3));
    await settle();
    assert.equal((await ask("snapshot", { context_id: "tab:3" })).error.reason, "outside_scope");
    const [group] = (await ask("group_list")).result.groups;
    assert.deepEqual(group.member_context_ids.sort(), ["tab:1", "tab:2"]);
    assert.equal(group.incomplete_membership, true);
  });

  it("follow_group shares human-added members after eligibility checks", async () => {
    const { c, ask } = await boot({ groupPolicy: "follow_group" });
    c.tabs.get(3).groupId = 9;
    await c.events.tabsOnUpdated.fire(3, { groupId: 9 }, c.tabs.get(3));
    await settle(60);
    assert.equal((await ask("snapshot", { context_id: "tab:3" })).ok, true);
  });

  it("follow_group never absorbs a tab the agent moved in, and the agent cannot import unauthorized tabs", async () => {
    const { c, ask } = await boot({ groupPolicy: "follow_group" });
    const [group] = (await ask("group_list")).result.groups;
    const attempt = await ask("group_add_tabs", { handle: group.handle, context_ids: ["tab:3"] });
    assert.equal(attempt.error.reason, "outside_scope");
    assert.equal(c.tabs.get(3).groupId, -1, "the unauthorized tab was not moved");
  });

  it("leaving the group ends access for good; re-entry does not restore it", async () => {
    const { c, ask } = await boot();
    c.tabs.get(2).groupId = -1;
    await c.events.tabsOnUpdated.fire(2, { groupId: -1 }, c.tabs.get(2));
    await settle(30);
    assert.equal((await ask("snapshot", { context_id: "tab:2" })).error.reason, "outside_scope");
    c.tabs.get(2).groupId = 9;
    await c.events.tabsOnUpdated.fire(2, { groupId: 9 }, c.tabs.get(2));
    await settle(30);
    assert.equal((await ask("snapshot", { context_id: "tab:2" })).error.reason, "outside_scope");
  });

  it("a group removed and re-created with the same title and id grants nothing", async () => {
    const { c, ask } = await boot({ grantTabs: [3] });
    const [group] = (await ask("group_list")).result.groups;
    for (const tabId of [1, 2, 5]) { c.tabs.get(tabId).groupId = -1; await c.events.tabsOnUpdated.fire(tabId, { groupId: -1 }, c.tabs.get(tabId)); }
    const removed = c.groups.get(9);
    c.groups.delete(9);
    await c.events.groupsOnRemoved.fire(removed, {});
    await settle(60);
    assert.equal((await ask("group_get", { handle: group.handle })).error.reason, "outside_scope");
    // Firefox recreates "Work" with the same numeric id and the old tabs.
    c.groups.set(9, { id: 9, windowId: 1, title: "Work", color: "blue", collapsed: false });
    for (const tabId of [1, 2]) { c.tabs.get(tabId).groupId = 9; await c.events.tabsOnUpdated.fire(tabId, { groupId: 9 }, c.tabs.get(tabId)); }
    await settle(30);
    assert.equal((await ask("snapshot", { context_id: "tab:1" })).error.reason, "outside_scope");
    assert.equal((await ask("group_list")).result.groups.length, 0);
    assert.equal((await ask("snapshot", { context_id: "tab:3" })).ok, true, "the independently selected tab keeps its own authority");
  });

  it("fixed group consent needs an explicit rebind after restart and never rematches by title or id", async () => {
    const first = await boot({ duration: { mode: "fixed", days: 7 } });
    const stored = Object.fromEntries(first.c.storage);
    assert.ok(!JSON.stringify(stored.zameryBrowserFirefoxConsentV1).includes('"Work"'));
    const second = await loadCompanion({ storage: stored, tabs: [{ id: 1, url: "https://a.test/1", groupId: 9, active: true }] });
    second.groups.set(9, { id: 9, windowId: 1, title: "Work", color: "blue", collapsed: false });
    second.state.contentHandlers.set(1, pageScript({ snapshotNodes: [NODE] }).handler);
    await second.hostStatus({ sessionId: "host-session-2" });
    const status = (await second.request({ id: rid(), op: "status", audience_id: AUD, params: {} })).result.authorization;
    assert.equal(status.state, "rebind_required");
    assert.equal((await second.request({ id: rid(), op: "group_list", audience_id: AUD, params: {} })).ok, false);
    assert.equal((await second.request({ id: rid(), op: "snapshot", audience_id: AUD, params: { context_id: "tab:1" } })).error.reason, "rebind_required");
  });
});

describe("group writes", () => {
  it("refuses group-wide changes while membership is incomplete (an unshared member would be affected)", async () => {
    const { ask } = await boot();
    const [group] = (await ask("group_list")).result.groups;
    for (const [op, extra] of [["group_update", { title: "New" }], ["group_move", { index: 0 }]]) {
      const response = await ask(op, { handle: group.handle, ...extra });
      assert.equal(response.error.reason, "incomplete_membership_structural_change_refused", op);
    }
  });

  it("updates and moves a group whose members are all authorized, with a read-back", async () => {
    const { c, ask } = await boot({ grantGroups: [], grantTabs: [1, 2] });
    const created = await ask("group_create", { context_ids: ["tab:1", "tab:2"], title: "Mine", color: "green" });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.result.outcome, "completed");
    assert.deepEqual(created.result.completed_substeps, ["group_created", "tabs_grouped", "group_updated"]);
    const handle = created.result.group_handle;
    assert.equal(created.result.group.title, "Mine");
    assert.equal(created.result.group.color, "green");
    assert.equal(c.tabs.get(1).groupId, c.tabs.get(2).groupId);

    const updated = await ask("group_update", { handle, title: "  Renamed\n  group ", collapsed: true });
    assert.equal(updated.result.group.title, "Renamed group");
    assert.equal(updated.result.group.collapsed, true);
    assert.equal((await ask("group_update", { handle, color: "neon" })).error.code, "INVALID_ARGUMENT");
    assert.equal((await ask("group_update", { handle })).error.reason, "empty_group_update");

    const moved = await ask("group_move", { handle, index: 0 });
    assert.equal(moved.result.completed_substeps[0], "group_moved");
    assert.equal((await ask("group_move", { handle, index: 0, window_id: 99 })).error.reason, "cross_window_group_move_refused");
  });

  it("creating a group needs independent authority for every tab and refuses pinned tabs", async () => {
    const { ask } = await boot({ grantGroups: [], grantTabs: [1, 7] });
    assert.equal((await ask("group_create", { context_ids: ["tab:1", "tab:3"] })).error.reason, "outside_scope");
    const pinned = await ask("group_create", { context_ids: ["tab:7"] });
    assert.equal(pinned.error.reason, "pinned_tab_refused");
  });

  it("reports a partial result with completed substeps when a later step fails, without inferring a rollback", async () => {
    const { c, ask } = await boot({ grantGroups: [], grantTabs: [1, 2] });
    c.browser.tabGroups.update = async () => { throw new Error("tabGroups.update exploded"); };
    const response = await ask("group_create", { context_ids: ["tab:1", "tab:2"], title: "T" });
    assert.equal(response.ok, true);
    assert.equal(response.result.outcome, "partially_applied");
    assert.deepEqual(response.result.completed_substeps, ["group_created", "tabs_grouped"]);
    assert.equal(c.tabs.get(1).groupId, c.tabs.get(2).groupId, "the grouping really happened and was not undone");
  });

  it("removing the last member deletes the group and withdraws its scope", async () => {
    const { c, ask } = await boot({ grantGroups: [], grantTabs: [1, 2] });
    const created = await ask("group_create", { context_ids: ["tab:1", "tab:2"] });
    const handle = created.result.group_handle;
    const first = await ask("group_remove_tabs", { handle, context_ids: ["tab:1"] });
    assert.equal(first.result.group.member_context_ids.join(), "tab:2");
    const last = await ask("group_remove_tabs", { handle, context_ids: ["tab:2"] });
    assert.equal(last.result.group, null);
    assert.equal((await ask("group_get", { handle })).error.reason, "outside_scope");
    assert.equal((await ask("snapshot", { context_id: "tab:1" })).ok, true, "directly granted tabs keep their authority");
    void c;
  });

  it("adding tabs requires membership, same window and no pinned tab", async () => {
    const { c, ask } = await boot({ grantGroups: [], grantTabs: [1, 2, 7] });
    const created = await ask("group_create", { context_ids: ["tab:1"] });
    const handle = created.result.group_handle;
    const added = await ask("group_add_tabs", { handle, context_ids: ["tab:2"] });
    assert.equal(added.result.group.member_context_ids.sort().join(), "tab:1,tab:2");
    assert.equal((await ask("group_add_tabs", { handle, context_ids: ["tab:7"] })).error.reason, "pinned_tab_refused");
    assert.equal((await ask("group_remove_tabs", { handle, context_ids: ["tab:7"] })).error.reason, "not_a_group_member");
    c.tabs.get(2).windowId = 2;
    c.windows.set(2, { id: 2, focused: false, incognito: false, type: "normal" });
    assert.equal((await ask("group_add_tabs", { handle, context_ids: ["tab:2"] })).error.reason, "cross_window_grouping_refused");
  });

  it("activating a group focuses an explicit authorized member and says which one, expanding a collapsed group", async () => {
    const { c, ask } = await boot({ grantGroups: [], grantTabs: [1, 2] });
    const created = await ask("group_create", { context_ids: ["tab:1", "tab:2"] });
    const handle = created.result.group_handle;
    await ask("group_update", { handle, collapsed: true });
    c.tabs.get(1).active = false;
    const activated = await ask("group_activate", { handle, context_id: "tab:2" });
    assert.equal(activated.result.focused_context_id, "tab:2");
    assert.deepEqual(activated.result.completed_substeps, ["group_expanded", "tab_activated", "window_focused"]);
    assert.equal(c.tabs.get(2).active, true);
    assert.equal(c.groups.get(c.tabs.get(2).groupId).collapsed, false);
    assert.equal((await ask("group_activate", { handle, context_id: "tab:3" })).error.reason, "outside_scope");
  });

  it("refuses every group write while the human is driving", async () => {
    const { c, ask } = await boot({ grantGroups: [], grantTabs: [1, 2] });
    const created = await ask("group_create", { context_ids: ["tab:1"] });
    await c.popup({ type: "zamery_browser_firefox_takeover" });
    for (const [op, params] of [
      ["group_create", { context_ids: ["tab:2"] }],
      ["group_update", { handle: created.result.group_handle, title: "x" }],
      ["group_add_tabs", { handle: created.result.group_handle, context_ids: ["tab:2"] }],
      ["group_remove_tabs", { handle: created.result.group_handle, context_ids: ["tab:1"] }],
      ["group_move", { handle: created.result.group_handle, index: 0 }],
      ["group_activate", { handle: created.result.group_handle }],
    ]) {
      assert.equal((await ask(op, params)).error.reason, "user_control", op);
    }
    assert.equal((await ask("group_list")).ok, true, "reads stay available");
  });

  it("requires the reorganize action", async () => {
    const { ask } = await boot({ actions: ["inspect", "interact"], grantGroups: [], grantTabs: [1] });
    assert.equal((await ask("group_create", { context_ids: ["tab:1"] })).error.reason, "action_outside_scope");
  });

  it("reports unsupported when this Firefox build has no tab group API", async () => {
    const { c, ask } = await boot({ noGroupsApi: true, grantGroups: [], grantTabs: [1] });
    const status = (await c.request({ id: rid(), op: "status", audience_id: AUD, params: {} })).result;
    assert.equal(status.features.tab_groups_api, false);
    const response = await ask("group_list");
    assert.equal(response.error.code, "UNSUPPORTED_CAPABILITY");
    const refused = await boot({ noGroupsApi: true, grantGroups: [9] });
    assert.equal(refused.granted.error, "tab_groups_api_unavailable");
  });

  it("group handles are not reachable by another audience", async () => {
    const { c, ask } = await boot();
    const [group] = (await ask("group_list")).result.groups;
    const other = await c.request({ id: rid(), op: "group_get", audience_id: "audience-other-zzzz", params: { handle: group.handle } });
    assert.equal(other.error.reason, "audience_mismatch");
  });
});

describe("tab navigation and activation", () => {
  async function bootTabs(actions = ACTIONS) {
    const stack = await boot({ grantGroups: [], grantTabs: [1], actions });
    return stack;
  }

  it("navigates an owned tab to any http(s) destination and re-homes its authorized origin", async () => {
    const { c, ask, pages } = await bootTabs();
    const created = await ask("create_tab", { url: "https://a.test/start" });
    const contextId = created.result.context_id;
    const tabId = Number(contextId.split(":")[1]);
    c.state.contentHandlers.set(tabId, pageScript({ snapshotNodes: [NODE] }).handler);
    const nav = await ask("navigate_tab", { context_id: contextId, url: "https://other.test/page" });
    assert.equal(nav.ok, true, JSON.stringify(nav));
    assert.deepEqual(nav.result.completed_substeps, ["tab_navigated"]);
    assert.equal(c.tabs.get(tabId).url, "https://other.test/page");
    assert.equal((await ask("snapshot", { context_id: contextId })).ok, true, "owned tab follows its own navigation");
    assert.equal((await ask("navigate_tab", { context_id: contextId, url: "javascript:alert(1)" })).error.reason, "unsupported_destination_scheme");
    assert.equal((await ask("navigate_tab", { context_id: contextId, url: "file:///etc/passwd" })).error.reason, "unsupported_destination_scheme");
    void pages;
  });

  it("restores the recorded origin when an owned navigation fails", async () => {
    const { c, ask } = await bootTabs();
    const created = await ask("create_tab", { url: "https://a.test/start" });
    const contextId = created.result.context_id;
    c.state.contentHandlers.set(Number(contextId.split(":")[1]), pageScript({ snapshotNodes: [NODE] }).handler);
    const realUpdate = c.browser.tabs.update;
    c.browser.tabs.update = async () => { throw new Error("blocked by policy"); };
    assert.equal((await ask("navigate_tab", { context_id: contextId, url: "https://other.test/" })).ok, false);
    c.browser.tabs.update = realUpdate;
    assert.equal((await ask("snapshot", { context_id: contextId })).ok, true);
  });

  it("a user's tab may only be navigated within its origin, after a claim, in the focused tab", async () => {
    const { ask } = await bootTabs();
    assert.equal((await ask("navigate_tab", { context_id: "tab:1", url: "https://a.test/next" })).error.reason, "claim_required");
    await ask("control_claim", { context_id: "tab:1" });
    assert.equal((await ask("navigate_tab", { context_id: "tab:1", url: "https://evil.test/" })).error.reason, "cross_origin_navigation_requires_user");
    const ok = await ask("navigate_tab", { context_id: "tab:1", url: "https://a.test/next" });
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });

  it("reload is a write: needs the claim for a user's tab, not for an owned tab", async () => {
    const { c, ask } = await bootTabs();
    assert.equal((await ask("reload_tab", { context_id: "tab:1" })).error.reason, "claim_required");
    await ask("control_claim", { context_id: "tab:1" });
    assert.equal((await ask("reload_tab", { context_id: "tab:1" })).ok, true);
    assert.equal(c.state.reloaded, 1);
  });

  it("activation focuses the tab and its window, and is refused during user control", async () => {
    const { c, ask } = await bootTabs();
    await c.popup({ type: "zamery_browser_firefox_revoke" });
    await c.popup({ type: "zamery_browser_firefox_grant", audience_id: AUD, tab_ids: [1, 2], actions: ACTIONS });
    const activated = await ask("activate_tab", { context_id: "tab:2" });
    assert.deepEqual(activated.result.completed_substeps, ["tab_activated", "window_focused"]);
    assert.equal(c.tabs.get(2).active, true);
    await c.popup({ type: "zamery_browser_firefox_takeover" });
    assert.equal((await ask("activate_tab", { context_id: "tab:1" })).error.reason, "user_control");
    assert.equal((await ask("navigate_tab", { context_id: "tab:2", url: "https://b.test/x" })).error.reason, "user_control");
  });

  it("will not navigate or activate tabs outside the grant", async () => {
    const { ask } = await bootTabs();
    for (const op of ["navigate_tab", "reload_tab", "activate_tab"]) {
      assert.equal((await ask(op, { context_id: "tab:3", url: "https://c.test/" })).error.reason, "outside_scope", op);
    }
  });
});
