import assert from "node:assert/strict";
import fs from "node:fs";
import { after, describe, it } from "node:test";

import { JSDOM } from "jsdom";

const HTML = fs.readFileSync(new URL("../runtime/companion/popup.html", import.meta.url), "utf8").replace(/<script[^>]*><\/script>/, "");
const JS = fs.readFileSync(new URL("../runtime/companion/popup.js", import.meta.url), "utf8");

const base = {
  state: "revoked", reason: null, current_host_session_id: "5d1e3bb0-7c2a-4e4e-a3a5-0d1f6c9a1111", granted_host_session_id: null,
  browser_run_epoch: "epoch", grant_id: null, grant_revision: 0, granted_at: null, expires_at: null, duration_mode: null, duration_days: null,
  scope_kind: null, scope_count: 0, actions: [], group_policy: null, audience_bound: false, expected_protocol_version: 2,
  current_host_protocol_version: 2, protocol_compatible: true, control: { state: "no_access", reason: null, resume_requested: false },
  audience_id: null, rebind: null, pending_origin_changes: {}, seen_audiences: [], scope_tabs: [], scope_groups: [],
};

const windows = [];
after(() => { for (const window of windows) window.close(); });

async function open(status, { tabs, groups = [], incognito = false } = {}) {
  const dom = new JSDOM(HTML, { url: "moz-extension://test/popup.html", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  windows.push(window);
  const sent = [];
  let current = status;
  window.browser = {
    runtime: { sendMessage: async (message) => { sent.push(message); return message.type === "zamery_browser_firefox_auth_status" ? current : { ok: true, ...current }; } },
    windows: { getCurrent: async () => ({ id: 1, incognito }) },
    tabs: { query: async () => tabs ?? [
      { id: 1, title: "Inbox", url: "https://mail.test/inbox", active: true, groupId: 4 },
      { id: 2, title: "Settings", url: "about:preferences", active: false, groupId: -1 },
    ] },
    tabGroups: groups ? { query: async () => groups } : undefined,
  };
  window.eval(JS);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const text = () => window.document.body.textContent.replace(/\s+/g, " ");
  return { window, document: window.document, sent, text, set: (next) => { current = next; } };
}

describe("popup states", () => {
  it("separates connection from shared access: disconnected", async () => {
    const popup = await open({ ...base, current_host_session_id: null });
    assert.match(popup.text(), /Local bridge not connected/);
    assert.ok(popup.document.querySelector("#picker").classList.contains("hidden"));
    assert.ok(popup.document.querySelector("#granted").classList.contains("hidden"));
  });

  it("blocks access and explains a protocol mismatch with both versions", async () => {
    const popup = await open({ ...base, protocol_compatible: false, current_host_protocol_version: 1 });
    assert.match(popup.text(), /Update needed/);
    assert.match(popup.text(), /protocol 2; the local bridge speaks 1/);
    assert.ok(popup.document.querySelector("#picker").classList.contains("hidden"));
  });

  it("connected but not granted: default current tab, restricted pages disabled, agent chosen from connected agents", async () => {
    const popup = await open({ ...base, seen_audiences: [{ audience_id: "aud-1", label: "MCP", first_seen: 1, last_seen: 2 }] });
    assert.ok(!popup.document.querySelector("#picker").classList.contains("hidden"));
    const boxes = [...popup.document.querySelectorAll("#tabs input")];
    assert.deepEqual(boxes.map((box) => [box.value, box.checked, box.disabled]), [["1", true, false], ["2", false, true]]);
    assert.match(popup.text(), /Local agent \(MCP\)/);
    assert.ok(!/Codex/i.test(popup.text()), "an unauthenticated process is never called Codex");
    assert.ok(!popup.text().includes(base.current_host_session_id.slice(0, 8)) || popup.document.querySelector("details").textContent.includes(base.current_host_session_id.slice(0, 8)), "session id only in diagnostics");
    assert.equal(popup.document.querySelector("#grant").disabled, false);
  });

  it("cannot share without a connected agent", async () => {
    const popup = await open(base);
    assert.equal(popup.document.querySelector("#grant").disabled, true);
    assert.match(popup.text(), /Ask your agent to check browser status/);
  });

  it("sends exactly the selected scope, actions and duration", async () => {
    const popup = await open({ ...base, seen_audiences: [{ audience_id: "aud-1", label: "", first_seen: 1, last_seen: 2 }] }, {
      groups: [{ id: 4, title: "Work" }],
    });
    popup.document.querySelector("#groups input").checked = true;
    popup.document.querySelector("#groups input").dispatchEvent(new popup.window.Event("change"));
    popup.document.querySelector('input[value="follow_group"]').checked = true;
    popup.document.querySelector("#act-reorganize").checked = true;
    popup.document.querySelector("#duration").value = "7";
    popup.document.querySelector("#duration").dispatchEvent(new popup.window.Event("change"));
    assert.match(popup.document.querySelector("#expiry-preview").textContent, /Access ends/);
    popup.document.querySelector("#grant").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const grant = popup.sent.find((message) => message.type === "zamery_browser_firefox_grant");
    assert.deepEqual({ ...grant, actions: [...grant.actions], tab_ids: [...grant.tab_ids], group_ids: [...grant.group_ids], duration: { ...grant.duration } }, {
      type: "zamery_browser_firefox_grant", audience_id: "aud-1", tab_ids: [1], group_ids: [4], group_policy: "follow_group",
      actions: ["inspect", "interact", "capture", "reorganize"], duration: { mode: "fixed", days: 7 },
    });
  });

  it("validates custom days 1..30 before enabling the grant", async () => {
    const popup = await open({ ...base, seen_audiences: [{ audience_id: "aud-1", label: "", first_seen: 1, last_seen: 2 }] });
    const select = popup.document.querySelector("#duration");
    select.value = "custom";
    select.dispatchEvent(new popup.window.Event("change"));
    const days = popup.document.querySelector("#custom-days");
    for (const [value, enabled] of [["0", false], ["31", false], ["", false], ["12", true], ["30", true], ["1", true]]) {
      days.value = value;
      days.dispatchEvent(new popup.window.Event("input"));
      assert.equal(popup.document.querySelector("#grant").disabled, !enabled, `custom ${value}`);
    }
    days.value = "12";
    days.dispatchEvent(new popup.window.Event("input"));
    popup.document.querySelector("#grant").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const grant = popup.sent.find((message) => message.type === "zamery_browser_firefox_grant");
    assert.equal(grant.allow_custom_duration, true);
    assert.equal(grant.duration.days, 12);
  });

  it("granted + agent controlling: shows scope, exact expiry, takeover; no resume button", async () => {
    const expires = Date.now() + 3 * 86_400_000;
    const popup = await open({ ...base, state: "granted", scope_count: 2, scope_kind: "tabs", actions: ["inspect", "interact"], duration_mode: "fixed", duration_days: 3, expires_at: expires, control: { state: "agent_claimed", reason: null, resume_requested: false } });
    assert.match(popup.text(), /Agent is controlling a shared tab/);
    assert.match(popup.text(), /2 tabs shared/);
    assert.match(popup.text(), /days left/);
    assert.match(popup.text(), /read, click & type/);
    assert.ok(popup.document.querySelector("#resume").classList.contains("hidden"));
    popup.document.querySelector("#takeover").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(popup.sent.some((message) => message.type === "zamery_browser_firefox_takeover"));
  });

  it("granted + user control: explains why and offers resume; the agent's request to resume is visible", async () => {
    const popup = await open({ ...base, state: "granted", scope_count: 1, actions: ["inspect"], duration_mode: "session", control: { state: "user_control", reason: "credential_field", resume_requested: true } });
    assert.match(popup.text(), /You are in control/);
    assert.match(popup.text(), /sign-in or code field/);
    assert.match(popup.text(), /agent asked to continue/);
    assert.ok(!popup.document.querySelector("#resume").classList.contains("hidden"));
    popup.document.querySelector("#resume").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(popup.sent.some((message) => message.type === "zamery_browser_firefox_resume"));
  });

  it("rebind: keeps the original deadline, locks duration, and explains the restart", async () => {
    const expires = Date.now() + 5 * 86_400_000;
    const popup = await open({ ...base, state: "rebind_required", reason: "restart", duration_mode: "fixed", duration_days: 7, expires_at: expires, audience_id: "aud-1", seen_audiences: [], rebind: { origins: ["https://mail.test"], count: 1 } });
    assert.match(popup.text(), /Firefox or the local bridge restarted/);
    assert.match(popup.text(), /still valid until/);
    assert.match(popup.text(), /mail\.test/);
    assert.equal(popup.document.querySelector("#duration").disabled, true);
    assert.match(popup.document.querySelector("#expiry-preview").textContent, /unchanged/);
    assert.equal(popup.document.querySelector("#grant").textContent, "Share again");
  });

  it("asks before sharing a shared tab's new site", async () => {
    const popup = await open({ ...base, state: "granted", scope_count: 1, actions: ["inspect"], duration_mode: "session", control: { state: "shared_idle" }, pending_origin_changes: { 7: { from: "https://a.test", to: "https://login.test" } } });
    assert.match(popup.text(), /moved to login\.test/);
    const buttons = [...popup.document.querySelectorAll("#pending-list button")];
    assert.deepEqual(buttons.map((b) => b.textContent), ["Share the new site", "Stop sharing this tab"]);
    buttons[0].click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(popup.sent.some((message) => message.type === "zamery_browser_firefox_confirm_origin" && message.tab_id === 7));
  });

  it("never lets a private window be shared", async () => {
    const popup = await open({ ...base, seen_audiences: [{ audience_id: "aud-1", label: "", first_seen: 1, last_seen: 2 }] }, { incognito: true });
    assert.ok([...popup.document.querySelectorAll("#tabs input")].every((box) => box.disabled && !box.checked));
    assert.match(popup.text(), /Private windows can't be shared/);
  });

  it("expired access says so plainly", async () => {
    const popup = await open({ ...base, state: "expired", reason: "authorization_expired", seen_audiences: [{ audience_id: "aud-1", label: "", first_seen: 1, last_seen: 2 }] });
    assert.match(popup.text(), /Access expired/);
  });
});
