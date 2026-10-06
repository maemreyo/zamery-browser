// LIVE acceptance against a real, isolated Firefox (temp profile, headless, differently-named host/extension id).
// Run explicitly:  pnpm --filter @zamery/browser-mcp live
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFirefoxBrowserProviderV2, createFirefoxRequestId, runFirefoxDoctor } from "@zamery/browser-firefox";

import { createBrowserMcpServer } from "../dist/index.js";
import { AUDIENCE, startLive } from "../../browser-firefox/live/live-env.mjs";
import { connectMarionette } from "../../browser-firefox/live/marionette.mjs";
import { decodePng, near } from "./png-decode.mjs";

let live;
let mcp;
let client;
let tabs = {};
const evidence = [];
const note = (name, detail) => evidence.push({ name, ...detail });
const call = async (name, args = {}) => client.callTool({ name, arguments: args });
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pageValue = async (tabId, code) => (await live.user("page_script", { tab_id: tabId, code })).result;

async function openTab(pathname, { origin, active = false } = {}) {
  const tab = await live.user("open_tab", { url: `${origin ?? live.origin}${pathname}`, active });
  await sleep(500);
  return tab;
}
async function connectMcp() {
  await client?.close().catch(() => undefined);
  await mcp?.close().catch(() => undefined);
  mcp = createBrowserMcpServer({
    version: "live",
    requestIdFactory: () => createFirefoxRequestId(),
    provider: () => createFirefoxBrowserProviderV2({ sessionsDir: live.sessionsDir, audienceId: AUDIENCE, autoClaim: false, clientLabel: "live-acceptance", artifactRoot: path.join(live.dirs.root, "artifacts") }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(serverTransport);
  client = new Client({ name: "live-agent", version: "1" });
  await client.connect(clientTransport);
}
async function share(tabIds, extra = {}) {
  await call("browser_status"); // registers the agent for the (simulated) user to pick
  const result = await live.user("grant", { audience_id: AUDIENCE, tab_ids: tabIds, duration: { mode: "session" }, ...extra });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function reset() {
  await live.user("revoke");
  for (const tab of (await live.user("tabs")).tabs.slice(1)) await live.user("close_tab", { tab_id: tab.id }).catch(() => undefined);
  for (const group of (await live.user("groups")).groups) void group;
  await sleep(200);
}

before(async () => {
  live = await startLive();
  await connectMcp();
  tabs.home = (await live.user("tabs")).tabs[0];
});
after(async () => {
  fs.writeFileSync(path.join(live.dirs.root, "evidence.json"), JSON.stringify({ at: new Date().toISOString(), firefox: evidence.find((e) => e.name === "environment"), checks: evidence }, null, 2));
  await client?.close().catch(() => undefined);
  await mcp?.close().catch(() => undefined);
  await live?.cleanup();
});

describe("live Firefox: environment and doctor", () => {
  it("runs a real Firefox with the protocol-2 companion and native host", async () => {
    const report = await runFirefoxDoctor({ sessionsDir: live.sessionsDir, homeDir: live.dirs.root });
    const session = report.sessions[0];
    assert.ok(session.observed, JSON.stringify(report.findings.filter((f) => f.id === "handshake")));
    assert.match(session.observed.firefoxVersion, /^\d+\./);
    assert.equal(session.hostProtocol, 2);
    assert.equal(session.companionProtocol, 2);
    assert.equal(session.observed.protocolCompatible, true);
    assert.equal(session.observed.features.tab_groups_api, true, "real Firefox exposes tab groups");
    assert.equal(session.observed.features.screenshots, true);
    note("environment", { firefox: session.observed.firefoxVersion, companion: session.observed.companionVersion, hostProtocol: session.hostProtocol, companionProtocol: session.companionProtocol, journalSchema: session.journalSchema, tabGroupsApi: true });
  });
});

describe("live Firefox: single-tab grant, privacy and acting", () => {
  let form, other, secret;
  before(async () => {
    await reset();
    form = await openTab("/form", { active: true });
    other = await openTab("/article");
    secret = await openTab("/login");
    await live.user("activate_tab", { tab_id: form.id });
    await share([form.id]);
  });

  it("shares exactly one tab: every other tab is invisible through every path", async () => {
    const contexts = await call("browser_contexts");
    assert.deepEqual(contexts.structuredContent.contexts.map((c) => c.context_id), [`tab:${form.id}`]);
    for (const tab of [other, secret, tabs.home]) {
      const snapshot = await call("browser_snapshot", { context_id: `tab:${tab.id}` });
      assert.equal(snapshot.isError, true, `tab ${tab.id}`);
      assert.equal(snapshot.structuredContent.error.reason, "outside_scope");
      const shot = await call("browser_screenshot", { context_id: `tab:${tab.id}` });
      assert.equal(shot.isError, true);
    }
    note("single-tab-isolation", { sharedTabs: 1, unsharedProbed: 3, snapshotDenied: true, screenshotDenied: true });
  });

  it("exports no form values or hidden controls from a real page, and ordinary text", async () => {
    const snap = await call("browser_snapshot", { context_id: `tab:${form.id}` });
    assert.equal(snap.isError, undefined, text(snap));
    const all = JSON.stringify(snap.structuredContent) + text(snap);
    for (const canary of ["PREFILLED-NAME-CANARY", "PREFILLED-NOTE-CANARY", "HIDDEN-CSRF-CANARY"]) assert.ok(!all.includes(canary), canary);
    assert.ok(snap.structuredContent.text_blocks.some((block) => /Profile form/.test(block.text)));
    assert.equal(snap.structuredContent.claim.claimed, true);
    note("snapshot-privacy", { valuesExported: false, canariesAbsent: 3, textBlocks: snap.structuredContent.text_blocks.length });
  });

  it("fills and clicks in the real DOM with synthetic events and verifies the page result", async () => {
    const snap = await call("browser_snapshot", { context_id: `tab:${form.id}` });
    const find = (name) => snap.structuredContent.nodes.find((node) => node.name === name).ref;
    const obs = snap.structuredContent.observation_id;
    const fill = await call("browser_fill", { context_id: `tab:${form.id}`, observation_id: obs, ref: find("Full name"), value: "Agent Name" });
    assert.equal(fill.isError, undefined, text(fill));
    const click = await call("browser_click", { context_id: `tab:${form.id}`, observation_id: obs, ref: find("Save") });
    assert.equal(click.isError, undefined, text(click));
    assert.equal(await pageValue(form.id, "document.getElementById('out').textContent"), "saved:Agent Name");
    note("act-real-dom", { fillOutcome: fill.structuredContent.outcome, clickOutcome: click.structuredContent.outcome, pageResult: "saved:Agent Name", eventsTrusted: false });
  });
});

describe("live Firefox: background control", () => {
  it("acts only on the shared background tab without stealing focus; takeover, resume and revoke remain authoritative", async () => {
    await reset();
    const shared = await openTab("/form", { active: true });
    const foreground = await openTab("/article");
    await live.user("activate_tab", { tab_id: shared.id });
    await share([shared.id], { control_mode: "background" });

    const snap = await call("browser_snapshot", { context_id: `tab:${shared.id}` });
    assert.equal(snap.structuredContent.claim.claimed, true);
    assert.equal((await call("browser_status")).structuredContent.authorization.control_mode, "background");
    const find = (name) => snap.structuredContent.nodes.find((node) => node.name === name).ref;

    await live.user("activate_tab", { tab_id: foreground.id });
    await sleep(500);
    let status = await call("browser_status");
    assert.equal(status.structuredContent.authorization.control.state, "agent_claimed", text(status));
    let realTabs = (await live.user("tabs")).tabs;
    assert.equal(realTabs.find((tab) => tab.id === foreground.id).active, true);
    assert.equal(realTabs.find((tab) => tab.id === shared.id).active, false);

    const deniedForeground = await call("browser_snapshot", { context_id: `tab:${foreground.id}` });
    assert.equal(deniedForeground.isError, true);
    assert.equal(deniedForeground.structuredContent.error.reason, "outside_scope");

    const fill = await call("browser_fill", {
      context_id: `tab:${shared.id}`,
      observation_id: snap.structuredContent.observation_id,
      ref: find("Full name"),
      value: "Background Agent",
    });
    assert.equal(fill.isError, undefined, text(fill));
    const click = await call("browser_click", {
      context_id: `tab:${shared.id}`,
      observation_id: snap.structuredContent.observation_id,
      ref: find("Save"),
    });
    assert.equal(click.isError, undefined, text(click));
    assert.equal(await pageValue(shared.id, "document.getElementById('out').textContent"), "saved:Background Agent");

    realTabs = (await live.user("tabs")).tabs;
    assert.equal(realTabs.find((tab) => tab.id === foreground.id).active, true, "foreground tab stayed active after background mutations");
    assert.equal(realTabs.find((tab) => tab.id === shared.id).active, false, "agent never focused the shared background tab");

    const fresh = await call("browser_snapshot", { context_id: `tab:${shared.id}` });
    const field = fresh.structuredContent.nodes.find((node) => node.name === "Full name").ref;
    await live.user("takeover");
    const blocked = await call("browser_fill", {
      context_id: `tab:${shared.id}`,
      observation_id: fresh.structuredContent.observation_id,
      ref: field,
      value: "must-not-write",
    });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.structuredContent.outcome, "not_started");
    assert.equal(await pageValue(shared.id, "document.getElementById('name').value"), "Background Agent");

    const requested = await call("browser_handoff", { action: "resume" });
    assert.equal(requested.structuredContent.control.resume_requested, true);
    await live.user("resume");
    const resumed = await call("browser_snapshot", { context_id: `tab:${shared.id}` });
    assert.equal(resumed.structuredContent.claim.claimed, true);
    const resumedField = resumed.structuredContent.nodes.find((node) => node.name === "Full name").ref;
    const resumedFill = await call("browser_fill", {
      context_id: `tab:${shared.id}`,
      observation_id: resumed.structuredContent.observation_id,
      ref: resumedField,
      value: "Background Resumed",
    });
    assert.equal(resumedFill.isError, undefined, text(resumedFill));
    realTabs = (await live.user("tabs")).tabs;
    assert.equal(realTabs.find((tab) => tab.id === foreground.id).active, true, "resume did not steal focus");

    await live.user("revoke");
    status = await call("browser_status");
    assert.equal(status.structuredContent.authorization.state, "revoked");
    const revoked = await call("browser_snapshot", { context_id: `tab:${shared.id}` });
    assert.equal(revoked.isError, true);
    note("background-control", {
      controlMode: "background",
      exactSharedContextOnly: true,
      foregroundStayedActive: true,
      takeoverBlockedWrite: true,
      resumedWithoutFocusSteal: true,
      revokeImmediate: true,
    });
  });

  it("keeps credential and cross-origin boundaries fail-closed while the claimed tab is backgrounded", async () => {
    await reset();
    const login = await openTab("/login", { active: true });
    const foreground = await openTab("/article");
    await live.user("activate_tab", { tab_id: login.id });
    await share([login.id], { control_mode: "background" });
    const loginSnap = await call("browser_snapshot", { context_id: `tab:${login.id}` });
    const password = loginSnap.structuredContent.nodes.find((node) => node.name === "Password").ref;
    await live.user("activate_tab", { tab_id: foreground.id });

    const refused = await call("browser_fill", {
      context_id: `tab:${login.id}`,
      observation_id: loginSnap.structuredContent.observation_id,
      ref: password,
      value: "agent-must-not-type-this",
    });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.outcome, "not_started");
    assert.equal(await pageValue(login.id, "document.getElementById('pw').value"), "PREFILLED-PASSWORD-CANARY");
    let realTabs = (await live.user("tabs")).tabs;
    assert.equal(realTabs.find((tab) => tab.id === foreground.id).active, true);

    await reset();
    const shared = await openTab("/form", { active: true });
    const other = await openTab("/article");
    await live.user("activate_tab", { tab_id: shared.id });
    await share([shared.id], { control_mode: "background" });
    await call("browser_snapshot", { context_id: `tab:${shared.id}` });
    await live.user("activate_tab", { tab_id: other.id });
    await live.user("navigate_tab", { tab_id: shared.id, url: `${live.altOrigin}/login` });
    await sleep(700);
    const denied = await call("browser_snapshot", { context_id: `tab:${shared.id}` });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.error.reason, "origin_changed_confirmation_required");
    realTabs = (await live.user("tabs")).tabs;
    assert.equal(realTabs.find((tab) => tab.id === other.id).active, true, "origin boundary handling did not steal focus");
    note("background-hard-boundaries", { credentialRefused: true, originConfirmationRequired: true, foregroundStayedActive: true });
  });
});

describe("live Firefox: human <-> agent control", () => {
  let tab;
  before(async () => { await reset(); });

  it("hands a sign-in page to the user: credential fields are flagged and refused, then resume works", async () => {
    tab = await openTab("/login", { active: true });
    await live.user("activate_tab", { tab_id: tab.id });
    await share([tab.id]);
    const snap = await call("browser_snapshot", { context_id: `tab:${tab.id}` });
    const flagged = snap.structuredContent.nodes.filter((node) => node.credential).map((node) => node.name).sort();
    assert.deepEqual(flagged, ["Password", "Verification code"]);
    assert.ok(!(JSON.stringify(snap.structuredContent) + text(snap)).includes("PREFILLED-PASSWORD-CANARY"));
    const password = snap.structuredContent.nodes.find((node) => node.name === "Password").ref;
    const fill = await call("browser_fill", { context_id: `tab:${tab.id}`, observation_id: snap.structuredContent.observation_id, ref: password, value: "agent-must-not-type-this" });
    assert.equal(fill.isError, true);
    assert.equal(fill.structuredContent.outcome, "not_started");
    assert.equal(await pageValue(tab.id, "document.getElementById('pw').value"), "PREFILLED-PASSWORD-CANARY", "the field was not touched");
    const status = await call("browser_status");
    assert.equal(status.structuredContent.authorization.control.state, "user_control");
    assert.equal(status.structuredContent.authorization.control.reason, "credential_field");

    const asked = await call("browser_handoff", { action: "resume" });
    assert.equal(asked.structuredContent.control.resume_requested, true);
    const stillBlocked = await call("browser_snapshot", { context_id: `tab:${tab.id}` });
    assert.equal(stillBlocked.structuredContent.claim.claimed, false);
    await live.user("resume");
    const fresh = await call("browser_snapshot", { context_id: `tab:${tab.id}` });
    assert.equal(fresh.structuredContent.claim.claimed, true);
    const user = fresh.structuredContent.nodes.find((node) => node.name === "Username").ref;
    const typed = await call("browser_fill", { context_id: `tab:${tab.id}`, observation_id: fresh.structuredContent.observation_id, ref: user, value: "agent-user" });
    assert.equal(typed.isError, undefined, text(typed));
    note("credential-handoff", { flagged, passwordUntouched: true, controlAfterRefusal: "user_control", resumedByUserOnly: true });
  });

  it("SPA update after an agent click makes the old ref stale without taking control from the agent", async () => {
    await reset();
    tab = await openTab("/spa", { active: true });
    await live.user("activate_tab", { tab_id: tab.id });
    await share([tab.id]);
    const snap = await call("browser_snapshot", { context_id: `tab:${tab.id}` });
    const next = snap.structuredContent.nodes.find((node) => node.name === "Go next").ref;
    const click = await call("browser_click", { context_id: `tab:${tab.id}`, observation_id: snap.structuredContent.observation_id, ref: next });
    assert.equal(click.isError, undefined, text(click));
    assert.equal(await pageValue(tab.id, "document.getElementById('title').textContent"), "Next view");
    const stale = await call("browser_click", { context_id: `tab:${tab.id}`, observation_id: snap.structuredContent.observation_id, ref: next });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.error.reason, "page_navigated");
    assert.equal((await call("browser_status")).structuredContent.authorization.control.state, "agent_claimed");
    note("spa-staleness", { oldRefStale: "page_navigated", agentStillClaimed: true });
  });

  it("a manual navigation of the claimed tab (same origin, not agent-attributed) takes control", async () => {
    const snap = await call("browser_snapshot", { context_id: `tab:${tab.id}` });
    assert.equal(snap.structuredContent.claim.claimed, true);
    await sleep(10_500); // outside the 10 s window in which URL changes are attributed to the agent
    await live.user("navigate_tab", { tab_id: tab.id, url: `${live.origin}/spa#/typed-in-urlbar` });
    await sleep(500);
    const control = (await call("browser_status")).structuredContent.authorization.control;
    assert.equal(control.state, "user_control");
    assert.equal(control.reason, "manual_navigation");
    note("manual-navigation", { control: control.state, reason: control.reason });
  });

  it("a shared tab that moves to another origin is withdrawn until the user confirms", async () => {
    await reset();
    tab = await openTab("/form", { active: true });
    await live.user("activate_tab", { tab_id: tab.id });
    await share([tab.id]);
    await call("browser_snapshot", { context_id: `tab:${tab.id}` });
    await live.user("navigate_tab", { tab_id: tab.id, url: `${live.altOrigin}/login` });
    await sleep(700);
    const denied = await call("browser_snapshot", { context_id: `tab:${tab.id}` });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.error.reason, "origin_changed_confirmation_required");
    const contexts = await call("browser_contexts");
    assert.equal(contexts.structuredContent.contexts[0].url, "");
    assert.ok(!text(contexts).includes("localhost"));
    assert.equal((await live.user("confirm_origin", { tab_id: tab.id })).ok, true);
    assert.equal((await call("browser_snapshot", { context_id: `tab:${tab.id}` })).isError, undefined);
    note("origin-change", { deniedUntilConfirmed: true, newSiteNotLeaked: true });
  });

  it("switching tabs takes control; a page-opened popup is never auto-shared", async () => {
    await reset();
    const a = await openTab("/form", { active: true });
    const b = await openTab("/article");
    await live.user("activate_tab", { tab_id: a.id });
    await share([a.id, b.id]);
    await call("browser_snapshot", { context_id: `tab:${a.id}` });
    const before = (await call("browser_contexts")).structuredContent.contexts.length;
    await live.user("page_script", { tab_id: a.id, code: `window.open("${live.origin}/colors", "_blank"); 1` });
    await sleep(800);
    assert.equal((await call("browser_contexts")).structuredContent.contexts.length, before, "the popup tab is not shared");
    await live.user("activate_tab", { tab_id: b.id });
    await sleep(500);
    const control = (await call("browser_status")).structuredContent.authorization.control;
    assert.equal(control.state, "user_control");
    assert.equal(control.reason, "tab_switched");
    note("tab-switch-and-popup", { popupShared: false, control: control.reason });
  });
});

describe("live Firefox: tab groups (real browser.tabGroups)", () => {
  const ACTIONS = ["inspect", "interact", "reorganize", "capture"];
  let g = [];
  let groupId;
  before(async () => {
    await reset();
    g = [await openTab("/form", { active: true }), await openTab("/article"), await openTab("/colors"), await openTab("/")];
    groupId = (await live.user("group", { tab_ids: [g[0].id, g[1].id, g[2].id], title: "Work", color: "blue" })).groupId;
    await live.user("activate_tab", { tab_id: g[0].id });
  });

  it("shares a human-made group by membership snapshot; later joiners are not shared; leaving ends access", async () => {
    await share([], { group_ids: [groupId], actions: ACTIONS });
    const listed = await call("browser_groups", { action: "list" });
    assert.equal(listed.isError, undefined, text(listed));
    const [group] = listed.structuredContent.groups;
    assert.match(group.handle, /^grp_/);
    assert.equal(group.title, "Work");
    assert.deepEqual(group.member_context_ids.sort(), g.slice(0, 3).map((t) => `tab:${t.id}`).sort());
    assert.equal(group.policy, "membership_snapshot");

    await live.user("move_into_group", { group_id: groupId, tab_ids: [g[3].id] });
    await sleep(500);
    const late = await call("browser_snapshot", { context_id: `tab:${g[3].id}` });
    assert.equal(late.structuredContent.error.reason, "outside_scope");
    const after = (await call("browser_groups", { action: "list" })).structuredContent.groups[0];
    assert.equal(after.incomplete_membership, true);

    await live.user("ungroup", { tab_ids: [g[2].id] });
    await sleep(500);
    assert.equal((await call("browser_snapshot", { context_id: `tab:${g[2].id}` })).structuredContent.error.reason, "outside_scope");
    await live.user("move_into_group", { group_id: groupId, tab_ids: [g[2].id] });
    await sleep(500);
    assert.equal((await call("browser_snapshot", { context_id: `tab:${g[2].id}` })).structuredContent.error.reason, "outside_scope", "re-entry does not restore access");
    note("group-membership-snapshot", { lateJoinerShared: false, leaverRegainedAccess: false, incompleteMembershipReported: true });
  });

  it("refuses group-wide edits while unshared members exist, and cannot import an unshared tab", async () => {
    const [group] = (await call("browser_groups", { action: "list" })).structuredContent.groups;
    const update = await call("browser_group", { action: "update", handle: group.handle, title: "Hijack" });
    assert.equal(update.isError, true);
    assert.equal(update.structuredContent.error.reason, "incomplete_membership_structural_change_refused");
    const groupsNow = (await live.user("groups")).groups;
    assert.equal(groupsNow.find((x) => x.id === groupId).title, "Work", "Firefox's real title is unchanged");
    const outsider = await call("browser_group", { action: "add_tabs", handle: group.handle, context_ids: [`tab:${g[3].id}`] });
    assert.equal(outsider.isError, true);
    assert.equal(outsider.structuredContent.error.code, "OUTSIDE_SCOPE");
    note("group-structural-protection", { updateRefused: true, importRefused: true });
  });

  it("agent-created groups use real Firefox APIs: create/update/move/activate/remove with read-back", async () => {
    await reset();
    g = [await openTab("/form", { active: true }), await openTab("/article")];
    await live.user("activate_tab", { tab_id: g[0].id });
    await share(g.map((t) => t.id), { actions: ACTIONS });
    const created = await call("browser_group", { action: "create", context_ids: g.map((t) => `tab:${t.id}`), title: "Agent group", color: "green" });
    assert.equal(created.isError, undefined, text(created));
    const handle = created.structuredContent.group.handle;
    const real = (await live.user("groups")).groups.find((x) => x.title === "Agent group");
    assert.ok(real, "the group exists in real Firefox");
    assert.equal(real.color, "green");

    const renamed = await call("browser_group", { action: "update", handle, title: "Renamed", collapsed: true });
    assert.equal(renamed.structuredContent.group.title, "Renamed");
    const after = (await live.user("groups")).groups.find((x) => x.id === real.id);
    assert.equal(after.title, "Renamed");
    assert.equal(after.collapsed, true);

    const moved = await call("browser_group", { action: "move", handle, index: 0 });
    assert.equal(moved.isError, undefined, text(moved));

    const activated = await call("browser_group", { action: "activate", handle, context_id: `tab:${g[1].id}` });
    assert.equal(activated.isError, undefined, text(activated));
    assert.equal(activated.structuredContent.focused_context_id, `tab:${g[1].id}`);
    const tabsNow = (await live.user("tabs")).tabs;
    assert.equal(tabsNow.find((t) => t.id === g[1].id).active, true);
    assert.equal((await live.user("groups")).groups.find((x) => x.id === real.id).collapsed, false, "activation expanded the collapsed group");

    await call("browser_group", { action: "remove_tabs", handle, context_ids: [`tab:${g[0].id}`] });
    const last = await call("browser_group", { action: "remove_tabs", handle, context_ids: [`tab:${g[1].id}`] });
    assert.equal(last.structuredContent.group, null);
    assert.equal((await live.user("groups")).groups.find((x) => x.id === real.id), undefined, "last-member removal deleted the group");
    assert.equal((await call("browser_groups", { action: "get", handle })).isError, true);
    note("group-write-real-firefox", { createUpdateMoveActivateRemove: true, lastMemberDeletesGroup: true, collapsedGroupExpandedOnActivate: true });
  });
});

describe("live Firefox: owned tab lifecycle", () => {
  let base;
  before(async () => {
    await reset();
    base = await openTab("/form", { active: true });
    await live.user("activate_tab", { tab_id: base.id });
    await share([base.id], { actions: ["inspect", "interact", "create_tab", "close_owned_tab"] });
  });

  it("creates, inspects, navigates, reloads and closes its own tab; refuses to close the user's; never duplicates on a repeated id", async () => {
    const created = await call("browser_tab", { action: "create", url: `${live.origin}/article`, request_id: "live-create-tab-0001" });
    assert.equal(created.isError, undefined, text(created));
    const contextId = created.structuredContent.context_id;
    const tabId = Number(contextId.split(":")[1]);
    const again = await call("browser_tab", { action: "create", url: `${live.origin}/article`, request_id: "live-create-tab-0001" });
    assert.equal(again.structuredContent.replayed, true);
    assert.equal(again.structuredContent.context_id, contextId);
    await sleep(800);
    assert.equal((await live.user("tabs")).tabs.filter((t) => t.url.endsWith("/article")).length, 1);
    await sleep(500);

    const snap = await call("browser_snapshot", { context_id: contextId });
    assert.equal(snap.isError, undefined, text(snap));
    assert.ok(snap.structuredContent.text_blocks.some((block) => /Quarterly report/.test(block.text)));

    const nav = await call("browser_tab", { action: "navigate", context_id: contextId, url: `${live.altOrigin}/colors` });
    assert.equal(nav.isError, undefined, text(nav));
    await sleep(700);
    assert.equal((await call("browser_snapshot", { context_id: contextId })).isError, undefined, "an owned tab follows its own navigation");
    assert.equal((await call("browser_tab", { action: "reload", context_id: contextId })).isError, undefined);

    const refused = await call("browser_tab", { action: "close_owned", context_id: `tab:${base.id}` });
    assert.equal(refused.isError, true);
    assert.ok((await live.user("tabs")).tabs.some((t) => t.id === base.id), "the user's tab is still open");
    const closed = await call("browser_tab", { action: "close_owned", context_id: contextId });
    assert.equal(closed.isError, undefined, text(closed));
    await sleep(300);
    assert.ok(!(await live.user("tabs")).tabs.some((t) => t.id === tabId));
    const badScheme = await call("browser_tab", { action: "create", url: "file:///etc/passwd" });
    assert.equal(badScheme.isError, true);
    note("owned-tab-lifecycle", { createInspectNavigateReloadClose: true, duplicateCreatePrevented: true, userTabCloseRefused: true, fileSchemeRefused: true });
  });
});

describe("live Firefox: screenshots as bounded artifacts", () => {
  let tab;
  before(async () => {
    await reset();
    tab = await openTab("/colors", { active: true });
    await live.user("activate_tab", { tab_id: tab.id });
    await share([tab.id]);
  });

  it("captures an exact rect of a real page and the pixels match the page (png), bounded by max_side", async () => {
    const box = JSON.parse(await pageValue(tab.id, "JSON.stringify((() => { const r = document.querySelector('.q').getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })())"));
    const result = await call("browser_screenshot", { context_id: `tab:${tab.id}`, format: "png", include_image: false, rect: { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.round(box.width), height: Math.round(box.height) } });
    assert.equal(result.isError, undefined, text(result));
    const file = result.structuredContent.local_path;
    const png = decodePng(fs.readFileSync(file));
    const { width, height } = png;
    assert.ok(width >= 100 && width <= 4096, `width ${width}`);
    assert.ok(near(png.pixel(5, 5), [220, 30, 30]), `top-left ${png.pixel(5, 5)}`);
    assert.ok(near(png.pixel(width - 6, 5), [30, 60, 220]), `top-right ${png.pixel(width - 6, 5)}`);
    assert.ok(near(png.pixel(5, height - 6), [30, 170, 60]), `bottom-left ${png.pixel(5, height - 6)}`);
    assert.ok(near(png.pixel(width - 6, height - 6), [240, 220, 30]), `bottom-right ${png.pixel(width - 6, height - 6)}`);
    note("screenshot-rect-pixels", { widthPx: width, heightPx: height, quadrantsMatch: true, devicePixelRatio: Number(await pageValue(tab.id, "window.devicePixelRatio")) });
  });

  it("downscales with max_side, defaults to the observed viewport, and returns a bounded JPEG image block", async () => {
    const small = await call("browser_screenshot", { context_id: `tab:${tab.id}`, format: "png", include_image: false, rect: { x: 0, y: 0, width: 400, height: 300 } });
    assert.equal(small.isError, undefined, text(small));
    const viewport = await call("browser_screenshot", { context_id: `tab:${tab.id}` });
    assert.equal(viewport.isError, undefined, text(viewport));
    const image = viewport.content.find((part) => part.type === "image");
    assert.ok(image, "inline image block present");
    assert.equal(image.mimeType, "image/jpeg");
    const bytes = Buffer.from(image.data, "base64");
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8]);
    assert.ok(bytes.length <= 300 * 1024, `inline image ${bytes.length} bytes`);
    assert.ok(Math.max(viewport.structuredContent.width, viewport.structuredContent.height) <= 1600);
    note("screenshot-viewport-jpeg", { bytes: bytes.length, width: viewport.structuredContent.width, height: viewport.structuredContent.height });
  });

  it("rejects out-of-bound requests before Firefox is asked, and artifacts die with the grant", async () => {
    // include_image=false means no max_side downscale, so the raw 4096x4096 request must hit the 8M-pixel budget.
    const tooBig = await call("browser_screenshot", { context_id: `tab:${tab.id}`, rect: { x: 0, y: 0, width: 4096, height: 4096 }, format: "png", include_image: false });
    assert.equal(tooBig.isError, true);
    assert.match(tooBig.structuredContent.error.code, /INVALID_ARGUMENT/);
    const shot = await call("browser_screenshot", { context_id: `tab:${tab.id}`, include_image: false });
    const id = shot.structuredContent.artifact_id;
    assert.equal((await call("browser_artifact_read", { artifact_id: id })).isError, undefined);
    await live.user("revoke");
    const gone = await call("browser_artifact_read", { artifact_id: id });
    assert.equal(gone.isError, true);
    assert.equal(gone.structuredContent.error.code, "ARTIFACT_EXPIRED");
    assert.equal(fs.existsSync(shot.structuredContent.local_path), false, "bytes deleted from disk");
    note("screenshot-limits-and-expiry", { oversizeRejected: true, artifactExpiredOnRevoke: true, fileDeleted: true });
  });
});

describe("live Firefox: private windows, restart and rebind", () => {
  it("never shares a private window", async () => {
    await reset();
    const base = await openTab("/form", { active: true });
    await share([base.id]);
    let opened;
    try { opened = await live.user("private_window", { url: `${live.origin}/login` }); } catch (error) { opened = { error: String(error.message) }; }
    await sleep(800);
    const contexts = (await call("browser_contexts")).structuredContent.contexts;
    assert.ok(contexts.every((c) => c.context_id === `tab:${base.id}`), "no private tab appears");
    for (const tabId of opened.tabIds ?? []) {
      const attempt = await live.user("grant", { audience_id: AUDIENCE, tab_ids: [tabId] }).catch((error) => ({ ok: false, error: String(error.message) }));
      assert.notEqual(attempt.ok, true);
      const snap = await call("browser_snapshot", { context_id: `tab:${tabId}` });
      assert.equal(snap.isError, true);
    }
    note("private-window", { opened: opened.error ? `not openable: ${opened.error}` : "opened", neverShared: true });
  });

  it("a fixed 3-day consent survives an extension reload as rebind_required with the same deadline; old refs are dead", async () => {
    await reset();
    const tab = await openTab("/form", { active: true });
    await live.user("activate_tab", { tab_id: tab.id });
    const granted = await share([tab.id], { duration: { mode: "fixed", days: 3 } });
    const snap = await call("browser_snapshot", { context_id: `tab:${tab.id}` });
    const oldSession = live.currentSession().session_id;
    await live.user("reload_extension");
    const session = await live.waitSession((s) => s.session_id !== oldSession);
    assert.notEqual(session.session_id, oldSession);
    await sleep(1500);
    const status = await call("browser_status");
    assert.equal(status.structuredContent.authorization.state, "rebind_required", text(status));
    assert.equal(Date.parse(status.structuredContent.authorization.expires_at), granted.expires_at);
    const dead = await call("browser_click", { context_id: `tab:${tab.id}`, observation_id: snap.structuredContent.observation_id, ref: "e1" });
    assert.equal(dead.isError, true);
    assert.equal((await call("browser_snapshot", { context_id: `tab:${tab.id}` })).structuredContent.error.reason, "rebind_required");
    const rebound = await live.user("grant", { audience_id: AUDIENCE, tab_ids: [tab.id] });
    assert.equal(rebound.ok, true, JSON.stringify(rebound));
    assert.equal(rebound.expires_at, granted.expires_at, "the original deadline is kept");
    assert.equal((await call("browser_snapshot", { context_id: `tab:${tab.id}` })).isError, undefined);
    note("extension-reload-rebind", { state: "rebind_required", deadlineKept: true, oldRefsDead: true, rebound: true });
  });

  it("a Firefox restart does not restore tab authority; an explicit rebind keeps the deadline", async () => {
    const before = (await live.user("status")).expires_at;
    assert.ok(before);
    await live.restartFirefox();
    await sleep(2500);
    await connectMcp();
    const status = await call("browser_status");
    const auth = status.structuredContent.authorization;
    assert.notEqual(auth.state, "granted", "tab authority is never restored automatically");
    note("firefox-restart", { stateAfterRestart: auth.state, reason: auth.reason, deadlineAfterRestart: auth.expires_at, originalDeadline: new Date(before).toISOString() });
    if (auth.state === "rebind_required") {
      assert.equal(Date.parse(auth.expires_at), before);
      const tabs2 = (await live.user("tabs")).tabs;
      const rebound = await live.user("grant", { audience_id: AUDIENCE, tab_ids: [tabs2[0].id] });
      assert.equal(rebound.ok, true, JSON.stringify(rebound));
      assert.equal(rebound.expires_at, before);
    }
  });
});

describe("live Firefox: trusted human gestures (Marionette-synthesized input)", () => {
  let marionette;
  after(() => marionette?.close());

  it("a trusted keystroke on the claimed tab takes control immediately, and the agent's observation dies", async () => {
    await reset();
    const tab = await openTab("/form", { active: true });
    await live.user("activate_tab", { tab_id: tab.id });
    await share([tab.id], { control_mode: "background" });
    const snap = await call("browser_snapshot", { context_id: `tab:${tab.id}` });
    assert.equal(snap.structuredContent.claim.claimed, true);
    const field = snap.structuredContent.nodes.find((node) => node.name === "Full name").ref;
    // Agent-origin events are untrusted and never trigger takeover (checked in the DOM-act test); a human key is trusted.
    marionette = await connectMarionette();
    await marionette.switchToUrl("/form");
    await marionette.type("#name", "typed by a human");
    await sleep(800);
    const control = (await call("browser_status")).structuredContent.authorization.control;
    assert.equal(control.state, "user_control");
    assert.equal(control.reason, "human_interaction");
    const blocked = await call("browser_fill", { context_id: `tab:${tab.id}`, observation_id: snap.structuredContent.observation_id, ref: field, value: "agent overwrite" });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.structuredContent.outcome, "not_started");
    assert.equal(await pageValue(tab.id, "document.getElementById('name').value"), "PREFILLED-NAME-CANARYtyped by a human", "the human's text was not overwritten");
    note("trusted-human-input", { source: "Marionette element send keys (isTrusted=true)", control: control.reason, agentWriteBlocked: true, humanTextPreserved: true });
  });

  it("a trusted click takes control too", async () => {
    await live.user("resume");
    const tabs = (await live.user("tabs")).tabs;
    const tab = tabs.find((t) => t.url.endsWith("/form"));
    await call("browser_snapshot", { context_id: `tab:${tab.id}` });
    await marionette.click("#save");
    await sleep(800);
    assert.equal((await call("browser_status")).structuredContent.authorization.control.state, "user_control");
    note("trusted-human-click", { control: "user_control" });
  });
});

describe("live Firefox: nothing sensitive reached disk", () => {
  it("typed values, refused secrets and page canaries are absent from the journal, host log and artifact metadata", async () => {
    const roots = [live.dirs.state, live.dirs.install, path.join(live.dirs.root, "artifacts")];
    const secrets = ["Agent Name", "agent-user", "Background Agent", "Background Resumed", "must-not-write", "agent-must-not-type-this", "typed by a human", "PREFILLED-NAME-CANARY", "PREFILLED-PASSWORD-CANARY", "HIDDEN-CSRF-CANARY"];
    const scanned = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) { walk(full); continue; }
        if (/\.(png|jpg)$/.test(name)) continue; // pixel bytes are the artifact itself, not metadata
        scanned.push(full);
        const content = fs.readFileSync(full, "utf8");
        for (const secret of secrets) assert.ok(!content.includes(secret), `${secret} found in ${full}`);
      }
    };
    roots.forEach(walk);
    assert.ok(scanned.some((file) => /mutation-journal-v2/.test(file)), "a journal exists and was scanned");
    note("canary-scan", { filesScanned: scanned.length, secretsChecked: secrets.length, found: 0 });
  });
});
