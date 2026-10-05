import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadCompanion, pageScript, settle } from "./helpers/companion-harness.mjs";

const AUD = "audience-aaaaaaaa";
const OTHER = "audience-bbbbbbbb";
const NODE = { node_id: "n1", role: "button", name: "Go", tag: "button" };

let sequence = 0;
const rid = (prefix = "req") => `${prefix}-${++sequence}`;

async function boot({ tabs, windows, storage, grant = true, duration, actions, audience = AUD, sessionId } = {}) {
  const company = await loadCompanion({
    tabs: tabs ?? [
      { id: 1, url: "https://a.test/page", title: "A", active: true },
      { id: 2, url: "https://b.test/secret", title: "B secret", active: false },
    ],
    windows,
    storage,
  });
  const pages = {};
  for (const tab of company.tabs.values()) {
    pages[tab.id] = pageScript({ snapshotNodes: [NODE] });
    company.state.contentHandlers.set(tab.id, pages[tab.id].handler);
  }
  await company.hostStatus(sessionId ? { sessionId } : {});
  await company.request({ id: rid("status"), op: "status", audience_id: audience, params: { client_label: "Test agent" } });
  let granted;
  if (grant) {
    granted = await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1], duration: duration ?? { mode: "session" }, actions, audience_id: audience });
    assert.equal(granted.ok, true, JSON.stringify(granted));
  }
  const ask = (op, params = {}, extra = {}) => company.request({ id: extra.id ?? rid(op), op, audience_id: extra.audience ?? audience, params });
  return { company, pages, ask, granted };
}

const refOf = (snapshot) => snapshot.result.nodes[0].ref;

async function claimedRef(ask, contextId = "tab:1") {
  const snapshot = await ask("snapshot", { context_id: contextId, claim: true });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.equal(snapshot.result.control.claimed_now, true);
  return refOf(snapshot);
}

describe("authorization scope (single tab)", () => {
  it("is not granted until a trusted popup grants a connected agent", async () => {
    const { company, ask } = await boot({ grant: false });
    const denied = await ask("snapshot", { context_id: "tab:1" });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "BROWSER_AUTHORIZATION_REQUIRED");
    assert.equal(denied.outcome, "not_started");

    // Messages that are not from the extension's own popup cannot grant.
    assert.equal(await company.nonPopup({ type: "zamery_browser_firefox_grant", tab_ids: [1], audience_id: AUD }), undefined);
    assert.equal(await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1], audience_id: "audience-never-seen" }).then((r) => r.error), "local_agent_not_connected");
  });

  it("only exposes the granted tab through every read path", async () => {
    const { company, ask } = await boot();
    const contexts = await ask("list_contexts");
    assert.deepEqual(contexts.result.contexts.map((c) => c.context_id), ["tab:1"]);
    assert.ok(!JSON.stringify(contexts).includes("B secret"));

    for (const [op, params] of [
      ["snapshot", { context_id: "tab:2" }],
      ["screenshot_capture", { context_id: "tab:2" }],
      ["asset_capabilities_v1", { context_id: "tab:2" }],
      ["asset_discover_v1", { context_id: "tab:2" }],
      ["act", { context_id: "tab:2", ref: "r1.x", action: "click" }],
      ["close_owned_tab", { context_id: "tab:2" }],
    ]) {
      const response = await ask(op, params);
      assert.equal(response.ok, false, op);
      assert.equal(response.error.reason, "outside_scope", `${op}: ${JSON.stringify(response.error)}`);
    }
    // The page script of the unshared tab was never even contacted.
    assert.equal(company.contentCalls.filter((call) => call.tabId === 2).length, 0);
  });

  it("does not reveal which unshared tab is active through heartbeats", async () => {
    const { company } = await boot({ tabs: [{ id: 1, url: "https://a.test/", active: false }, { id: 2, url: "https://b.test/", active: true }] });
    await settle(50);
    const beats = company.nativeMessages.filter((m) => m.type === "heartbeat");
    assert.ok(beats.length > 0);
    for (const beat of beats) assert.equal(beat.active_context_id, null);
  });

  it("binds the grant to one consumer audience", async () => {
    const { company, ask } = await boot();
    const intruder = await ask("list_contexts", {}, { audience: OTHER });
    assert.equal(intruder.error.reason, "audience_mismatch");
    const status = await company.request({ id: rid(), op: "status", audience_id: OTHER, params: {} });
    assert.equal(status.result.authorization.state, "revoked");
    assert.equal(status.result.authorization.reason, "bound_to_other_consumer");
    assert.equal(status.result.authorization.scope_count, 0);
    const mine = await company.request({ id: rid(), op: "status", audience_id: AUD, params: {} });
    assert.equal(mine.result.authorization.state, "granted");
  });

  it("never grants private windows or unsupported pages", async () => {
    const { company } = await boot({
      grant: false,
      tabs: [
        { id: 1, url: "https://a.test/", active: true },
        { id: 5, url: "https://private.test/", windowId: 9, incognito: true },
        { id: 6, url: "about:preferences", windowId: 1 },
      ],
      windows: { 1: { id: 1, focused: true, type: "normal" }, 9: { id: 9, focused: false, incognito: true, type: "normal" } },
    });
    for (const tabId of [5, 6]) {
      const result = await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [tabId], audience_id: AUD });
      assert.equal(result.ok, false);
      assert.equal(result.error, "selected_tabs_are_not_supported_web_pages");
    }
  });

  it("withdraws a tab that navigates to another origin until the user confirms, without leaking the new site", async () => {
    const { company, ask } = await boot();
    await company.tabs.get(1) && Object.assign(company.tabs.get(1), { url: "https://evil.test/phish" });
    await company.events.tabsOnUpdated.fire(1, { url: "https://evil.test/phish" }, company.tabs.get(1));
    const denied = await ask("snapshot", { context_id: "tab:1" });
    assert.equal(denied.error.reason, "origin_changed_confirmation_required");
    const contexts = await ask("list_contexts");
    assert.deepEqual(contexts.result.contexts[0].availability.reason, "origin_changed_confirmation_required");
    assert.equal(contexts.result.contexts[0].url, "");
    assert.ok(!JSON.stringify(contexts).includes("evil.test"));

    const popupStatus = await company.popup({ type: "zamery_browser_firefox_auth_status" });
    assert.equal(popupStatus.pending_origin_changes["1"].to, "https://evil.test");
    assert.equal((await company.popup({ type: "zamery_browser_firefox_confirm_origin", tab_id: 1 })).ok, true);
    assert.equal((await ask("snapshot", { context_id: "tab:1" })).ok, true);
  });

  it("drops authority when the shared tab closes and ends the grant when none remain", async () => {
    const { company, ask } = await boot();
    await company.browser.tabs.remove(1);
    const response = await ask("list_contexts");
    assert.equal(response.ok, false);
    const status = await company.request({ id: rid(), op: "status", audience_id: AUD, params: {} });
    assert.equal(status.result.authorization.state, "revoked");
    assert.equal(status.result.authorization.reason, "authorized_tabs_closed");
  });
});

describe("revocation and result delivery (F02)", () => {
  it("denies replay of a completed mutation after revoke and regrant", async () => {
    const { company, ask } = await boot();
    const ref = await claimedRef(ask);
    const id = rid("mutation");
    const first = await ask("act", { context_id: "tab:1", ref, action: "click" }, { id });
    assert.equal(first.ok, true);
    assert.equal(first.result.outcome, "completed");

    await company.popup({ type: "zamery_browser_firefox_revoke" });
    await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1], audience_id: AUD });
    const replay = await ask("act", { context_id: "tab:1", ref, action: "click" }, { id });
    assert.equal(replay.ok, false);
    assert.equal(replay.replayed === true, false);
    assert.equal(replay.error.code === "BROWSER_AUTHORIZATION_REQUIRED" || replay.error.code === "STALE_ELEMENT_REF", true, JSON.stringify(replay));
    assert.equal(company.pages?.length, undefined);
  });

  it("never replays page-bearing reads after revoke (the original probe: same id, stale snapshot)", async () => {
    const { company, ask } = await boot();
    const id = rid("snap");
    const first = await ask("snapshot", { context_id: "tab:1" }, { id });
    assert.equal(first.ok, true);
    await company.popup({ type: "zamery_browser_firefox_revoke" });
    const replay = await ask("snapshot", { context_id: "tab:1" }, { id });
    assert.equal(replay.ok, false);
    assert.equal(replay.result, undefined);
    assert.equal(replay.error.code, "BROWSER_AUTHORIZATION_REQUIRED");
    // Even after a fresh grant, an old read id is simply re-executed under current authority, never served from cache.
    await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1], audience_id: AUD });
    const before = company.contentCalls.length;
    const again = await ask("snapshot", { context_id: "tab:1" }, { id });
    assert.equal(again.ok, true);
    assert.ok(company.contentCalls.length > before, "read was re-executed, not replayed from cache");
  });

  it("withholds a read result when the grant is revoked while the read is in flight", async () => {
    const { company, pages, ask } = await boot();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = pages[1].handler;
    company.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_snapshot") await gate;
      return original(message, tab);
    });
    const pendingRead = ask("snapshot", { context_id: "tab:1" });
    await settle(30);
    await company.popup({ type: "zamery_browser_firefox_revoke" });
    release();
    const response = await pendingRead;
    assert.equal(response.ok, false);
    assert.equal(response.result, undefined);
    assert.equal(response.error.reason, "authorization_changed_during_request");
  });

  it("reports only a safe completed status when authority ends mid-mutation, and does not claim an undo", async () => {
    const { company, pages, ask } = await boot();
    const ref = await claimedRef(ask);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    pages[1].handler = pages[1].handler.bind(null);
    const original = company.state.contentHandlers.get(1);
    company.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_act") { await gate; return { ok: true, mechanism: "dom-synthetic", page_text: "PAGE-CANARY" }; }
      return original(message, tab);
    });
    const pending = ask("act", { context_id: "tab:1", ref, action: "click" });
    await settle(40);
    await company.popup({ type: "zamery_browser_firefox_revoke" });
    release();
    const response = await pending;
    assert.equal(response.ok, true);
    assert.equal(response.outcome, "completed");
    assert.equal(response.authority_ended, true);
    assert.ok(!JSON.stringify(response).includes("PAGE-CANARY"));
  });

  it("revocation clears refs, so an old ref cannot act after a fresh grant", async () => {
    const { company, ask } = await boot();
    const ref = await claimedRef(ask);
    await company.popup({ type: "zamery_browser_firefox_revoke" });
    await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1], audience_id: AUD });
    await ask("control_claim", { context_id: "tab:1" });
    const response = await ask("act", { context_id: "tab:1", ref, action: "click" });
    assert.equal(response.ok, false);
    assert.equal(response.error.reason, "grant_changed");
  });

  it("denies a queued write that starts after the grant ended", async () => {
    const { company, pages, ask } = await boot();
    const ref = await claimedRef(ask);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = company.state.contentHandlers.get(1);
    company.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_act") await gate;
      return original(message, tab);
    });
    const first = ask("act", { context_id: "tab:1", ref, action: "click" });
    await settle(30);
    const queued = ask("act", { context_id: "tab:1", ref, action: "click" });
    await settle(30);
    await company.popup({ type: "zamery_browser_firefox_revoke" });
    release();
    await first;
    const response = await queued;
    assert.equal(response.ok, false);
    assert.equal(response.outcome, "not_started");
    assert.equal(pages[1].acts.length <= 1, true, "the queued write must not be dispatched");
  });
});

describe("duration, restart and explicit rebind", () => {
  it("rejects out-of-range and non-preset durations through the real popup message", async () => {
    const { company } = await boot({ grant: false });
    for (const days of [0, 31, 90, -3, 1.5, "7"]) {
      const result = await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1], audience_id: AUD, allow_custom_duration: true, duration: { mode: "fixed", days } });
      assert.equal(result.ok, false, String(days));
      assert.equal(result.error, "invalid_authorization_duration");
    }
    const custom = await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1], audience_id: AUD, duration: { mode: "fixed", days: 5 } });
    assert.equal(custom.error, "custom_authorization_duration_requires_explicit_intent");
    const forever = await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1], audience_id: AUD, duration: { mode: "until_revoked" } });
    assert.equal(forever.ok, false);
  });

  it("computes the exact deadline and reports it", async () => {
    const before = Date.now();
    const { granted } = await boot({ duration: { mode: "fixed", days: 7 } });
    assert.equal(granted.duration_mode, "fixed");
    assert.equal(granted.duration_days, 7);
    assert.ok(granted.expires_at >= before + 7 * 86_400_000 && granted.expires_at <= Date.now() + 7 * 86_400_000);
  });

  it("session consent never survives a restart", async () => {
    const first = await boot();
    const second = await loadCompanion({ storage: Object.fromEntries(first.company.storage), tabs: [{ id: 1, url: "https://a.test/", active: true }] });
    await second.hostStatus();
    const status = await second.request({ id: rid(), op: "status", audience_id: AUD, params: {} });
    assert.equal(status.result.authorization.state, "revoked");
  });

  it("fixed consent survives a restart as rebind_required, grants no authority, and keeps its deadline on explicit rebind", async () => {
    const first = await boot({ duration: { mode: "fixed", days: 3 } });
    const original = first.granted;
    const second = await loadCompanion({ storage: Object.fromEntries(first.company.storage), tabs: [{ id: 41, url: "https://a.test/", title: "A", active: true }, { id: 1, url: "https://a.test/", active: false }] });
    for (const id of [1, 41]) second.state.contentHandlers.set(id, pageScript({ snapshotNodes: [NODE] }).handler);
    await second.hostStatus({ sessionId: "host-session-2" });
    const statusCall = () => second.request({ id: rid(), op: "status", audience_id: AUD, params: {} });
    let status = (await statusCall()).result.authorization;
    assert.equal(status.state, "rebind_required");
    assert.equal(status.expires_at, original.expires_at);

    // Same numeric tab id exists after "restart" but must not regain authority.
    const denied = await second.request({ id: rid(), op: "snapshot", audience_id: AUD, params: { context_id: "tab:1" } });
    assert.equal(denied.error.reason, "rebind_required");
    assert.equal((await second.request({ id: rid(), op: "list_contexts", audience_id: AUD, params: {} })).ok, false);

    const popupView = await second.popup({ type: "zamery_browser_firefox_auth_status" });
    assert.deepEqual(popupView.rebind.origins, ["https://a.test"]);

    const rebound = await second.popup({ type: "zamery_browser_firefox_grant", tab_ids: [41], audience_id: AUD });
    assert.equal(rebound.ok, true, JSON.stringify(rebound));
    assert.equal(rebound.expires_at, original.expires_at, "rebind keeps the original deadline");
    assert.equal(rebound.grant_id, original.grant_id);
    assert.equal((await second.request({ id: rid(), op: "snapshot", audience_id: AUD, params: { context_id: "tab:41" } })).ok, true);
    assert.equal((await second.request({ id: rid(), op: "snapshot", audience_id: AUD, params: { context_id: "tab:1" } })).error.reason, "outside_scope");
  });

  it("drops fixed consent that expired while the browser was closed", async () => {
    const first = await boot({ duration: { mode: "fixed", days: 1 } });
    const stored = JSON.parse(JSON.stringify(first.company.storage.get("zameryBrowserFirefoxConsentV1")));
    const longAgo = Date.now() - 3 * 86_400_000;
    stored.issuedAt = longAgo; stored.expiresAt = longAgo + 86_400_000; stored.lastSeenAt = longAgo;
    const second = await loadCompanion({ storage: { ...Object.fromEntries(first.company.storage), zameryBrowserFirefoxConsentV1: stored }, tabs: [{ id: 1, url: "https://a.test/", active: true }] });
    await second.hostStatus();
    const status = (await second.request({ id: rid(), op: "status", audience_id: AUD, params: {} })).result.authorization;
    assert.equal(status.state, "expired");
    assert.equal(second.storage.has("zameryBrowserFirefoxConsentV1"), false);
  });

  it("requires revalidation when the wall clock moved backwards", async () => {
    const first = await boot({ duration: { mode: "fixed", days: 7 } });
    const stored = JSON.parse(JSON.stringify(first.company.storage.get("zameryBrowserFirefoxConsentV1")));
    stored.lastSeenAt = Date.now() + 2 * 3_600_000; // "last seen" two hours in the future
    const second = await loadCompanion({ storage: { ...Object.fromEntries(first.company.storage), zameryBrowserFirefoxConsentV1: stored }, tabs: [{ id: 1, url: "https://a.test/", active: true }] });
    await second.hostStatus();
    const status = (await second.request({ id: rid(), op: "status", audience_id: AUD, params: {} })).result.authorization;
    assert.equal(status.state, "rebind_required");
    assert.equal(status.reason, "clock_regression_revalidation_required");
    const blind = await second.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1], audience_id: AUD });
    assert.equal(blind.error, "clock_regression_confirmation_required");
  });

  it("a new native host session invalidates the live binding (session grant ends, fixed grant needs rebind)", async () => {
    const session = await boot();
    await session.company.hostStatus({ sessionId: "host-session-2" });
    assert.equal((await session.ask("list_contexts")).ok, false);
    assert.equal((await session.company.request({ id: rid(), op: "status", audience_id: AUD, params: {} })).result.authorization.state, "revoked");

    const fixed = await boot({ duration: { mode: "fixed", days: 7 } });
    await fixed.company.hostStatus({ sessionId: "host-session-2" });
    assert.equal((await fixed.company.request({ id: rid(), op: "status", audience_id: AUD, params: {} })).result.authorization.state, "rebind_required");
  });

  it("losing the native port drops the binding immediately", async () => {
    const { company, ask } = await boot({ duration: { mode: "fixed", days: 3 } });
    const connections = company.state.connectCount;
    await company.nativeOnDisconnect.fire({});
    await settle(1200); // the companion reconnects after one second
    assert.equal(company.state.connectCount, connections + 1);
    await company.hostStatus({ sessionId: "host-session-3" });
    const response = await ask("list_contexts");
    assert.equal(response.ok, false);
    const status = await company.request({ id: rid(), op: "status", audience_id: AUD, params: {} });
    assert.equal(status.result.authorization.state, "rebind_required");
    assert.equal(status.result.authorization.reason, "native_disconnect");
  });
});

describe("protocol mismatch fails closed", () => {
  it("denies everything but status when the host speaks another protocol", async () => {
    const { company, ask } = await boot({ grant: false });
    await company.hostStatus({ protocol: 1 });
    const read = await ask("list_contexts");
    assert.equal(read.error.code, "BROWSER_PROTOCOL_MISMATCH");
    const grant = await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1], audience_id: AUD });
    assert.equal(grant.error, "native_host_protocol_version_mismatch");
    const status = await company.request({ id: rid(), op: "status", audience_id: AUD, params: {} });
    assert.equal(status.result.authorization.protocol_compatible, false);
  });

  it("revokes a live grant when the host protocol changes underneath it", async () => {
    const { company, ask } = await boot();
    await company.hostStatus({ protocol: 1 });
    assert.equal((await ask("list_contexts")).ok, false);
  });
});

describe("human <-> agent control", () => {
  it("requires a claim and a fresh observation before any write", async () => {
    const { ask } = await boot();
    const snapshot = await ask("snapshot", { context_id: "tab:1" });
    const noClaim = await ask("act", { context_id: "tab:1", ref: refOf(snapshot), action: "click" });
    assert.equal(noClaim.error.reason, "claim_required");
    assert.equal(noClaim.outcome, "not_started");
  });

  it("refs from before a claim are stale; refs from the claiming snapshot work", async () => {
    const { ask } = await boot();
    const early = await ask("snapshot", { context_id: "tab:1" });
    const ref = await claimedRef(ask);
    const stale = await ask("act", { context_id: "tab:1", ref: refOf(early), action: "click" });
    assert.equal(stale.error.reason, "claim_changed");
    assert.equal((await ask("act", { context_id: "tab:1", ref, action: "click" })).ok, true);
  });

  it("user takeover blocks writes, invalidates refs, and only the user can resume", async () => {
    const { company, ask } = await boot();
    const ref = await claimedRef(ask);
    assert.equal((await company.popup({ type: "zamery_browser_firefox_takeover" })).control.state, "user_control");
    const blocked = await ask("act", { context_id: "tab:1", ref, action: "click" });
    assert.equal(blocked.error.reason, "user_control");

    const claimAttempt = await ask("control_claim", { context_id: "tab:1" });
    assert.equal(claimAttempt.error.reason, "user_control");
    const snapshotWhileUser = await ask("snapshot", { context_id: "tab:1", claim: true });
    assert.equal(snapshotWhileUser.ok, true, "reads stay available");
    assert.equal(snapshotWhileUser.result.control.claimed_now, false);
    assert.equal(snapshotWhileUser.result.control.claim_refused_reason, "user_control");

    const requested = await ask("control_request_resume");
    assert.equal(requested.result.resume_requested, true);
    assert.equal((await ask("act", { context_id: "tab:1", ref, action: "click" })).error.reason, "user_control");

    assert.equal((await company.popup({ type: "zamery_browser_firefox_resume" })).control.state, "shared_idle");
    assert.equal((await ask("act", { context_id: "tab:1", ref, action: "click" })).error.reason, "claim_required");
    const fresh = await claimedRef(ask);
    assert.equal((await ask("act", { context_id: "tab:1", ref: fresh, action: "click" })).ok, true);
    assert.equal((await ask("act", { context_id: "tab:1", ref, action: "click" })).error.reason, "claim_changed", "pre-takeover ref stays dead");
  });

  it("agent-requested takeover (MFA) hands the page to the user", async () => {
    const { company, ask } = await boot();
    await claimedRef(ask);
    const result = await ask("control_takeover", { note: "Please complete MFA" });
    assert.equal(result.result.state, "user_control");
    const status = await company.popup({ type: "zamery_browser_firefox_auth_status" });
    assert.equal(status.control.reason, "agent_requested");
  });

  it("treats a trusted human gesture on the claimed tab as takeover", async () => {
    const { company, ask } = await boot();
    const ref = await claimedRef(ask);
    await company.nonPopup({ type: "zamery_browser_firefox_interaction" }, { id: "zamery-browser-firefox@zamery.local", tab: { id: 1 } });
    assert.equal((await ask("act", { context_id: "tab:1", ref, action: "click" })).error.reason, "user_control");
  });

  it("ignores interaction messages that do not come from our own content script", async () => {
    const { company, ask } = await boot();
    const ref = await claimedRef(ask);
    await company.nonPopup({ type: "zamery_browser_firefox_interaction" }, { id: "evil@example", tab: { id: 1 } });
    await company.nonPopup({ type: "zamery_browser_firefox_interaction" }, { id: "zamery-browser-firefox@zamery.local" });
    assert.equal((await ask("act", { context_id: "tab:1", ref, action: "click" })).ok, true);
  });

  it("detects a human edit that happened between observation and action (same-node edit)", async () => {
    const { company, pages, ask } = await boot();
    const ref = await claimedRef(ask);
    pages[1].interactionGeneration += 1;
    const response = await ask("act", { context_id: "tab:1", ref, action: "fill", value: "x" });
    assert.equal(response.error.reason, "user_interaction");
    assert.equal(response.outcome, "not_started");
    assert.equal(pages[1].acts.length, 0);
    assert.equal((await company.popup({ type: "zamery_browser_firefox_auth_status" })).control.state, "user_control");
  });

  it("makes refs stale after in-page (SPA) navigation or a new document", async () => {
    const { company, pages, ask } = await boot();
    let ref = await claimedRef(ask);
    company.tabs.get(1).url = "https://a.test/page#/other";
    assert.equal((await ask("act", { context_id: "tab:1", ref, action: "click" })).error.reason, "page_navigated");
    ref = await claimedRef(ask);
    pages[1].documentId = "doc-2";
    assert.equal((await ask("act", { context_id: "tab:1", ref, action: "click" })).error.reason, "document_changed");
  });

  it("does not silently retarget: the claimed tab must be the active tab of the focused window", async () => {
    const { company, pages, ask } = await boot({ tabs: [{ id: 1, url: "https://a.test/", active: true }, { id: 3, url: "https://a.test/other", active: false }] });
    const ref = await claimedRef(ask);
    company.tabs.get(1).active = false; // e.g. focus moved without an event reaching us
    const response = await ask("act", { context_id: "tab:1", ref, action: "click" });
    assert.equal(response.error.reason, "claimed_tab_not_focused");
    assert.equal(pages[1].acts.length, 0);
  });

  it("a tab switch in the claimed window is a takeover", async () => {
    const { company, ask } = await boot({ tabs: [{ id: 1, url: "https://a.test/", active: true }, { id: 3, url: "https://b.test/", active: false }] });
    await claimedRef(ask);
    await company.browser.tabs.update(3, { active: true });
    await settle();
    assert.equal((await company.popup({ type: "zamery_browser_firefox_auth_status" })).control.state, "user_control");
  });

  it("manual navigation of the claimed tab (same origin, not agent-attributed) is a takeover", async () => {
    const { company, ask } = await boot();
    await claimedRef(ask);
    company.tabs.get(1).url = "https://a.test/typed-in-urlbar";
    await company.events.tabsOnUpdated.fire(1, { url: "https://a.test/typed-in-urlbar" }, company.tabs.get(1));
    assert.equal((await company.popup({ type: "zamery_browser_firefox_auth_status" })).control.reason, "manual_navigation");
  });

  it("credential fields hand over to the user instead of being filled", async () => {
    const { company, pages, ask } = await boot();
    pages[1].onAct = null;
    company.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_act") return { error: { code: "USER_TAKEOVER_REQUIRED", reason: "credential_field" } };
      return pages[1].handler(message, tab);
    });
    const ref = await claimedRef(ask);
    const response = await ask("act", { context_id: "tab:1", ref, action: "fill", value: "hunter2" });
    assert.equal(response.result.outcome, "not_started");
    assert.equal((await company.popup({ type: "zamery_browser_firefox_auth_status" })).control.reason, "credential_field");
  });

  it("an unknown action outcome (response lost) hands control back to the human", async () => {
    const { company, ask } = await boot();
    const ref = await claimedRef(ask);
    const original = company.state.contentHandlers.get(1);
    company.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_act") throw new Error("Message manager disconnected");
      return original(message, tab);
    });
    const response = await ask("act", { context_id: "tab:1", ref, action: "click" });
    assert.equal(response.ok, false);
    assert.equal(response.outcome, "outcome_unknown");
    assert.equal((await company.popup({ type: "zamery_browser_firefox_auth_status" })).control.state, "user_control");
  });

  it("closing the claimed tab releases the claim", async () => {
    const { company, ask } = await boot({ tabs: [{ id: 1, url: "https://a.test/", active: true }, { id: 3, url: "https://a.test/b", active: false }] });
    await company.popup({ type: "zamery_browser_firefox_revoke" });
    await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1, 3], audience_id: AUD });
    await ask("control_claim", { context_id: "tab:1" });
    await company.browser.tabs.remove(1);
    assert.equal((await company.popup({ type: "zamery_browser_firefox_auth_status" })).control.state, "shared_idle");
  });
});

describe("owned tab lifecycle", () => {
  it("refuses to create a tab without the create_tab action", async () => {
    const { ask } = await boot();
    const response = await ask("create_tab", { url: "https://a.test/new" });
    assert.equal(response.error.reason, "create_tab_not_granted");
  });

  it("creates only http(s) tabs in a normal non-private window and registers them in scope", async () => {
    const { company, ask } = await boot({ actions: ["inspect", "interact", "create_tab", "close_owned_tab"] });
    const bad = await ask("create_tab", { url: "about:config" });
    assert.equal(bad.error.reason, "unsupported_destination_scheme");
    assert.equal((await ask("create_tab", { url: "javascript:alert(1)" })).ok, false);
    const created = await ask("create_tab", { url: "https://a.test/new" });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.result.ownership, "provider-owned");
    assert.equal(company.state.createdWith.windowId, 1);
    const contexts = (await ask("list_contexts")).result.contexts;
    assert.ok(contexts.some((c) => c.context_id === created.result.context_id && c.ownership === "provider-owned"));
  });

  it("will not open a tab when the only focused window is private", async () => {
    const { ask } = await boot({
      actions: ["inspect", "interact", "create_tab"],
      windows: { 1: { id: 1, focused: false, type: "normal" }, 9: { id: 9, focused: true, incognito: true, type: "normal" } },
    });
    const response = await ask("create_tab", { url: "https://a.test/new" });
    assert.equal(response.error.reason, "no_normal_window_available");
  });

  it("closes only provider-owned tabs", async () => {
    const { company, ask } = await boot({ actions: ["inspect", "interact", "create_tab", "close_owned_tab"] });
    const refused = await ask("close_owned_tab", { context_id: "tab:1" });
    assert.equal(refused.error.code, "CONTEXT_NOT_OWNED");
    assert.ok(company.tabs.has(1));
    const created = await ask("create_tab", { url: "https://a.test/new" });
    const closed = await ask("close_owned_tab", { context_id: created.result.context_id });
    assert.equal(closed.ok, true);
  });
});

describe("widening an active grant", () => {
  it("adds tabs without touching the deadline, actions or audience, and refuses ineligible pages", async () => {
    const { company, ask, granted } = await boot({
      duration: { mode: "fixed", days: 3 },
      tabs: [
        { id: 1, url: "https://a.test/page", title: "A", active: true },
        { id: 2, url: "https://b.test/x", title: "B", active: false },
        { id: 3, url: "about:config", title: "Config", active: false },
      ],
    });
    assert.equal((await ask("snapshot", { context_id: "tab:2" })).error.reason, "outside_scope");
    const refused = await company.popup({ type: "zamery_browser_firefox_add_tabs", tab_ids: [3] });
    assert.equal(refused.error, "selected_tabs_are_not_supported_web_pages");
    const added = await company.popup({ type: "zamery_browser_firefox_add_tabs", tab_ids: [2] });
    assert.equal(added.ok, true);
    assert.equal(added.expires_at, granted.expires_at);
    assert.equal(added.scope_count, 2);
    assert.deepEqual(added.actions, granted.actions);
    assert.equal((await ask("snapshot", { context_id: "tab:2" })).ok, true);
    assert.equal(company.nonPopup && (await company.nonPopup({ type: "zamery_browser_firefox_add_tabs", tab_ids: [3] })), undefined);
    const stored = company.storage.get("zameryBrowserFirefoxConsentV1");
    assert.equal(stored.scopeSummary.count, 2);
    assert.ok(stored.grantRevision > granted.grant_revision);
  });
});

describe("review regressions", () => {
  it("does not remember a refused (not_started) mutation, so the same id can be retried after re-sharing", async () => {
    const { company, ask } = await boot();
    const id = rid("retry");
    const ref = await claimedRef(ask);
    const refused = await ask("act", { context_id: "tab:2", ref, action: "click" }, { id }).catch(() => null);
    assert.equal(refused.error.reason, "outside_scope");
    // Same id, now on the shared tab: it must execute rather than replay the refusal.
    const retried = await ask("act", { context_id: "tab:1", ref, action: "click" }, { id });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    void company;
  });

  it("agent-initiated activation and navigation are not mistaken for the user", async () => {
    const { company, ask } = await boot({ tabs: [{ id: 1, url: "https://a.test/", active: true }, { id: 3, url: "https://a.test/b", active: false }] });
    await company.popup({ type: "zamery_browser_firefox_revoke" });
    await company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1, 3], audience_id: AUD });
    await ask("control_claim", { context_id: "tab:1" });
    assert.equal((await ask("activate_tab", { context_id: "tab:3" })).ok, true);
    await settle(50);
    assert.equal((await company.popup({ type: "zamery_browser_firefox_auth_status" })).control.state, "agent_claimed", "own activation is not a takeover");

    // A user-driven switch right after the attribution window still counts.
    await settle(3_100);
    await company.browser.tabs.update(1, { active: true }); // back to the claimed tab: not a switch away
    await company.browser.tabs.update(3, { active: true });
    await settle(50);
    assert.equal((await company.popup({ type: "zamery_browser_firefox_auth_status" })).control.reason, "tab_switched");
  });

  it("an owned-tab navigation by the agent never looks like a manual one, even after a long idle", async () => {
    const { company, ask } = await boot();
    await ask("control_claim", { context_id: "tab:1" });
    const original = company.browser.tabs.update;
    company.browser.tabs.update = async (tabId, props) => {
      company.tabs.get(tabId).url = props.url;
      await company.events.tabsOnUpdated.fire(tabId, { url: props.url }, company.tabs.get(tabId)); // fires before the call resolves
      return original(tabId, props);
    };
    const nav = await ask("navigate_tab", { context_id: "tab:1", url: "https://a.test/other" });
    assert.equal(nav.ok, true, JSON.stringify(nav));
    assert.equal((await company.popup({ type: "zamery_browser_firefox_auth_status" })).control.state, "agent_claimed");
  });

  it("shows the agent's hand-off note to the user, marked unverified", async () => {
    const { company, ask } = await boot();
    await ask("control_claim", { context_id: "tab:1" });
    await ask("control_takeover", { note: "Please enter the 2FA code" });
    const status = await company.popup({ type: "zamery_browser_firefox_auth_status" });
    assert.equal(status.handoff_note, "Please enter the 2FA code");
    const consumerView = await company.nonPopup({ type: "zamery_browser_firefox_auth_status" });
    assert.equal(consumerView.handoff_note, undefined);
  });
});
