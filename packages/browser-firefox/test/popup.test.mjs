import assert from "node:assert/strict";
import fs from "node:fs";
import { after, describe, it } from "node:test";

import { JSDOM } from "jsdom";

const HTML = fs.readFileSync(new URL("../runtime/companion/popup.html", import.meta.url), "utf8").replace(/<script[^>]*><\/script>/, "");
const JS = fs.readFileSync(new URL("../runtime/companion/popup.js", import.meta.url), "utf8");

const base = {
  state: "revoked", reason: null, current_host_session_id: "5d1e3bb0-7c2a-4e4e-a3a5-0d1f6c9a1111", granted_host_session_id: null,
  browser_run_epoch: "epoch", grant_id: null, grant_revision: 0, granted_at: null, expires_at: null, duration_mode: null, duration_days: null, control_mode: null,
  scope_kind: null, scope_count: 0, actions: [], group_policy: null, audience_bound: false, expected_protocol_version: 2,
  current_host_protocol_version: 2, protocol_compatible: true, control: { state: "no_access", reason: null, resume_requested: false },
  audience_id: null, rebind: null, pending_origin_changes: {}, seen_audiences: [], scope_tabs: [], scope_groups: [],
};

const windows = [];
after(() => { for (const window of windows) window.close(); });

async function open(status, { tabs, groups = [], incognito = false, permissionGranted = false, permissionRequestResult = true } = {}) {
  const dom = new JSDOM(HTML, { url: "moz-extension://test/popup.html", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  windows.push(window);
  const sent = [];
  const permissionCalls = [];
  const tabRows = tabs ?? [
    { id: 1, title: "Inbox", url: "https://mail.test/inbox", active: true, groupId: 4 },
    { id: 2, title: "Settings", url: "about:preferences", active: false, groupId: -1 },
  ];
  let current = status;
  let notificationsPermission = permissionGranted;
  window.browser = {
    runtime: { sendMessage: async (message) => {
      sent.push(message);
      if (message.type === "zamery_browser_firefox_auth_status") return current;
      if (message.type === "zamery_browser_firefox_set_notifications") {
        current = {
          ...current,
          notifications_preferred: message.enabled === true,
          notifications_permission: notificationsPermission,
          notifications_enabled: message.enabled === true && notificationsPermission,
        };
        return { ok: message.enabled !== true || notificationsPermission, enabled: current.notifications_enabled, permission: notificationsPermission };
      }
      return { ok: true, ...current };
    } },
    permissions: {
      request: async (request) => {
        permissionCalls.push({ action: "request", request });
        if (!permissionRequestResult) return false;
        notificationsPermission = true;
        return true;
      },
      remove: async (request) => {
        permissionCalls.push({ action: "remove", request });
        notificationsPermission = false;
        return true;
      },
    },
    windows: { getCurrent: async () => ({ id: 1, incognito }) },
    tabs: {
      query: async () => tabRows,
      get: async (id) => tabRows.find((tab) => tab.id === id) ?? null,
    },
    tabGroups: groups ? {
      query: async () => groups,
      get: async (id) => groups.find((group) => group.id === id) ?? null,
    } : undefined,
  };
  window.eval(JS);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const text = () => window.document.body.textContent.replace(/\s+/g, " ");
  return { window, document: window.document, sent, permissionCalls, text, set: (next) => { current = next; } };
}

describe("popup states", () => {
  it("keeps notifications optional in the manifest and does not widen required permissions", () => {
    for (const name of ["manifest.json", "manifest.development.json"]) {
      const manifest = JSON.parse(fs.readFileSync(new URL(`../runtime/companion/${name}`, import.meta.url), "utf8"));
      assert.deepEqual(manifest.optional_permissions, ["notifications"], name);
      assert.ok(!manifest.permissions.includes("notifications"), name);
      assert.deepEqual([...manifest.permissions].sort(), ["<all_urls>", "nativeMessaging", "storage", "tabGroups", "tabs"].sort(), name);
    }
  });

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
    assert.equal(popup.document.querySelector("#control-background").checked, false);
    assert.ok(!popup.text().includes(base.current_host_session_id.slice(0, 8)) || popup.document.querySelector("#diagnostics").textContent.includes(base.current_host_session_id.slice(0, 8)), "session id only in diagnostics");
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
    popup.document.querySelector("#control-background").checked = true;
    popup.document.querySelector("#control-background").dispatchEvent(new popup.window.Event("change"));
    popup.document.querySelector("#duration").value = "7";
    popup.document.querySelector("#duration").dispatchEvent(new popup.window.Event("change"));
    assert.match(popup.document.querySelector("#expiry-preview").textContent, /Access ends/);
    popup.document.querySelector("#grant").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const grant = popup.sent.find((message) => message.type === "zamery_browser_firefox_grant");
    assert.deepEqual({ ...grant, actions: [...grant.actions], tab_ids: [...grant.tab_ids], group_ids: [...grant.group_ids], duration: { ...grant.duration } }, {
      type: "zamery_browser_firefox_grant", audience_id: "aud-1", tab_ids: [1], group_ids: [4], group_policy: "follow_group",
      control_mode: "background", actions: ["inspect", "interact", "capture", "reorganize"], duration: { mode: "fixed", days: 7 },
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
    const popup = await open({ ...base, state: "granted", scope_count: 2, scope_kind: "tabs", actions: ["inspect", "interact"], duration_mode: "fixed", duration_days: 3, expires_at: expires, control_mode: "background", control: { state: "agent_claimed", reason: null, resume_requested: false } });
    assert.match(popup.text(), /Agent is controlling a shared tab/);
    assert.match(popup.text(), /2 tabs shared/);
    assert.match(popup.text(), /days left/);
    assert.match(popup.text(), /read, click & type/);
    assert.match(popup.text(), /Background control: on/);
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

  it("Manage Access renders current scope and sends only reductions", async () => {
    const popup = await open({
      ...base,
      state: "granted", grant_id: "grant-1", grant_revision: 3, scope_count: 2, scope_kind: "group",
      actions: ["inspect", "interact", "capture"], duration_mode: "session", control_mode: "background",
      control: { state: "shared_idle", reason: null, resume_requested: false },
      scope_tabs: [
        { tab_id: 1, origin: "https://mail.test", via_group: null },
        { tab_id: 3, origin: "https://docs.test", via_group: "grp_123" },
      ],
      scope_groups: [{ handle: "grp_123", policy: "membership_snapshot", native_group_id: 4 }],
    }, {
      tabs: [
        { id: 1, title: "Inbox", url: "https://mail.test/inbox", active: true, groupId: -1 },
        { id: 3, title: "Project docs", url: "https://docs.test/one", active: false, groupId: 4 },
      ],
      groups: [{ id: 4, title: "Work" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.match(popup.text(), /Inbox/);
    assert.match(popup.text(), /Project docs/);
    assert.match(popup.text(), /Group: Work/);
    assert.equal(popup.document.querySelector("#manage-reorganize").disabled, true, "Manage Access cannot add a missing capability");

    popup.document.querySelector('#manage-tabs input[value="3"]').checked = false;
    popup.document.querySelector("#manage-capture").checked = false;
    popup.document.querySelector("#manage-background").checked = false;
    popup.document.querySelector("#manage-save").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const message = popup.sent.find((entry) => entry.type === "zamery_browser_firefox_manage_access");
    assert.deepEqual({
      tab_ids: [...message.tab_ids], group_handles: [...message.group_handles], actions: [...message.actions], control_mode: message.control_mode,
    }, {
      tab_ids: [1], group_handles: ["grp_123"], actions: ["inspect", "interact"], control_mode: "interactive",
    });
  });

  it("rebind: keeps the original deadline, locks duration, and explains the restart", async () => {
    const expires = Date.now() + 5 * 86_400_000;
    const popup = await open({ ...base, state: "rebind_required", reason: "restart", duration_mode: "fixed", duration_days: 7, expires_at: expires, control_mode: "background", audience_id: "aud-1", seen_audiences: [], rebind: { origins: ["https://mail.test"], count: 1 } });
    assert.match(popup.text(), /Firefox or the local bridge restarted/);
    assert.match(popup.text(), /still valid until/);
    assert.match(popup.text(), /mail\.test/);
    assert.equal(popup.document.querySelector("#duration").disabled, true);
    assert.equal(popup.document.querySelector("#control-background").disabled, true);
    assert.equal(popup.document.querySelector("#control-background").checked, true);
    assert.match(popup.document.querySelector("#expiry-preview").textContent, /unchanged/);
    assert.equal(popup.document.querySelector("#grant").textContent, "Share again");
  });

  it("makes the user confirm a clock change before sharing again, and shows the agent's note as unverified", async () => {
    const popup = await open({ ...base, state: "rebind_required", reason: "clock_regression_revalidation_required", duration_mode: "fixed", duration_days: 7, expires_at: Date.now() + 86_400_000, audience_id: "aud-1", seen_audiences: [{ audience_id: "aud-1", label: "", first_seen: 1, last_seen: 2 }], rebind: { origins: [], count: 1 } });
    assert.ok(!popup.document.querySelector("#clock-row").classList.contains("hidden"));
    assert.equal(popup.document.querySelector("#grant").disabled, true);
    popup.document.querySelector("#clock-confirm").checked = true;
    popup.document.querySelector("#clock-confirm").dispatchEvent(new popup.window.Event("change"));
    assert.equal(popup.document.querySelector("#grant").disabled, false);
    popup.document.querySelector("#grant").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(popup.sent.find((m) => m.type === "zamery_browser_firefox_grant").confirm_clock_change, true);

    const plain = await open({ ...base, state: "rebind_required", reason: "restart", duration_mode: "fixed", duration_days: 7, expires_at: Date.now() + 86_400_000, audience_id: "aud-1", seen_audiences: [{ audience_id: "aud-1", label: "", first_seen: 1, last_seen: 2 }], rebind: { origins: [], count: 1 } });
    plain.document.querySelector("#grant").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(plain.sent.find((m) => m.type === "zamery_browser_firefox_grant").confirm_clock_change, false, "no silent confirmation");

    const note = await open({ ...base, state: "granted", scope_count: 1, actions: ["inspect"], duration_mode: "session", control: { state: "user_control", reason: "agent_requested", resume_requested: false }, handoff_note: "Please enter the 2FA code" });
    assert.match(note.text(), /The agent says \(not verified\): Please enter the 2FA code/);
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

  it("shows access attention and requests notification permission only from the user toggle", async () => {
    const popup = await open({
      ...base,
      attention: { reason: "access_requested", created_at: Date.now(), expires_at: Date.now() + 60_000 },
      seen_audiences: [{ audience_id: "aud-1", label: "MCP", first_seen: 1, last_seen: 2 }],
      notifications_preferred: false,
      notifications_permission: false,
      notifications_enabled: false,
    });
    assert.match(popup.text(), /A local agent is waiting/);
    assert.match(popup.text(), /Choose what to share/);
    assert.equal(popup.permissionCalls.length, 0, "render never prompts for optional permission");

    const toggle = popup.document.querySelector("#notify-attention");
    toggle.checked = true;
    toggle.dispatchEvent(new popup.window.Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(popup.permissionCalls.length, 1);
    assert.equal(popup.permissionCalls[0].action, "request");
    assert.equal(popup.permissionCalls[0].request.permissions[0], "notifications");
    assert.ok(popup.sent.some((message) => message.type === "zamery_browser_firefox_set_notifications" && message.enabled === true));
    assert.equal(toggle.checked, true);
  });

  it("keeps toolbar fallback usable when Firefox denies notification permission", async () => {
    const popup = await open({
      ...base,
      attention: { reason: "resume_requested", created_at: Date.now(), expires_at: Date.now() + 60_000 },
      notifications_preferred: false,
      notifications_permission: false,
      notifications_enabled: false,
    }, { permissionRequestResult: false });
    const toggle = popup.document.querySelector("#notify-attention");
    toggle.checked = true;
    toggle.dispatchEvent(new popup.window.Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(toggle.checked, false);
    assert.match(popup.document.querySelector("#error").textContent, /Toolbar alerts still work/);
    assert.ok(popup.sent.some((message) => message.type === "zamery_browser_firefox_set_notifications" && message.enabled === false));
  });
});
