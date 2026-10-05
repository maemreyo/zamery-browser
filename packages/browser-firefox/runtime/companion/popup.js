const $ = (selector) => document.querySelector(selector);
const PRESET_DAYS = new Set([1, 3, 7, 14, 30]);

let lastStatus = null;
let pickerDirty = false;
let busy = false;

const REASONS = {
  user_takeover: "You took over.",
  agent_requested: "The agent asked you to take over.",
  human_interaction: "You used the page.",
  manual_navigation: "You navigated the page.",
  origin_changed: "The site changed.",
  tab_switched: "You switched tabs.",
  window_switched: "You switched windows.",
  credential_field: "The agent reached a sign-in or code field.",
  outcome_unknown: "An action may or may not have happened. Please check the page.",
  restart: "Firefox or the local bridge restarted.",
  native_disconnect: "The local bridge disconnected.",
  native_host_session_changed: "The local bridge restarted.",
  native_host_protocol_mismatch: "The companion and local bridge versions do not match.",
  clock_regression_revalidation_required: "The system clock moved back. Please confirm again.",
  user_revoked: "You stopped sharing.",
  authorization_expired: "Access expired.",
  authorized_tabs_closed: "The shared tabs were closed.",
};

function reasonText(reason) {
  return reason ? REASONS[reason] || "" : "";
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

function formatWhen(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function remainingText(ms) {
  const minutes = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (minutes < 90) return `${minutes} min left`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h left`;
  return `${Math.round(hours / 24)} days left`;
}

function element(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

async function send(message) {
  return browser.runtime.sendMessage(message);
}

function setDot(id, tone) {
  $(id).className = `dot ${tone}`;
}

function agentLabel(entry) {
  const label = entry?.label ? ` (${entry.label})` : "";
  return `Local agent${label}`;
}

// ---- status -------------------------------------------------------------------------------------------

function renderConnection(status) {
  const connected = Boolean(status.current_host_session_id);
  if (!connected) {
    setDot("#connection-dot", "bad");
    $("#connection-text").textContent = "Local bridge not connected";
    $("#connection-detail").textContent = "Install or restart the Zamery local bridge, then reopen this panel.";
  } else if (!status.protocol_compatible) {
    setDot("#connection-dot", "bad");
    $("#connection-text").textContent = "Update needed";
    $("#connection-detail").textContent = `Companion speaks protocol ${status.expected_protocol_version}; the local bridge speaks ${status.current_host_protocol_version ?? "?"}. Access is blocked until both are updated.`;
  } else {
    setDot("#connection-dot", "ok");
    $("#connection-text").textContent = "Connected to the local bridge";
    $("#connection-detail").textContent = "";
  }
  return connected && status.protocol_compatible;
}

function renderControl(status) {
  const control = status.control || {};
  const tone = control.state === "agent_claimed" ? "ok" : control.state === "user_control" ? "warn" : "ok";
  setDot("#control-dot", control.state === "shared_idle" ? "ok" : tone);
  let title = "Ready — the agent is not controlling a tab";
  if (control.state === "agent_claimed") title = "Agent is controlling a shared tab";
  if (control.state === "user_control") title = "You are in control";
  $("#control-text").textContent = title;
  $("#control-detail").textContent = control.state === "user_control"
    ? [reasonText(control.reason), control.resume_requested ? "The agent asked to continue." : ""].filter(Boolean).join(" ")
    : "";
  $("#agent-note").textContent = "";
  $("#takeover").disabled = control.state === "user_control";
  $("#resume").classList.toggle("hidden", control.state !== "user_control");
}

function renderGranted(status) {
  $("#granted").classList.remove("hidden");
  renderControl(status);
  const count = status.scope_count;
  const kind = status.scope_kind === "group" ? "from a tab group" : "";
  $("#shared-summary").textContent = `${count} tab${count === 1 ? "" : "s"} shared ${kind}`.trim();
  $("#shared-expiry").textContent = status.duration_mode === "fixed"
    ? `Until ${formatWhen(status.expires_at)} (${remainingText(status.expires_at)}). Restarting Firefox asks you to confirm which tabs again.`
    : "Until you stop sharing or restart Firefox.";
  const labels = { inspect: "read", interact: "click & type", capture: "screenshots", reorganize: "reorganize", create_tab: "open its own tabs", close_owned_tab: "close its own tabs" };
  $("#shared-actions").textContent = `Allowed: ${status.actions.map((action) => labels[action] || action).join(", ")}`;

  const pending = status.pending_origin_changes || {};
  const ids = Object.keys(pending);
  $("#pending").classList.toggle("hidden", ids.length === 0);
  const list = $("#pending-list");
  list.replaceChildren();
  for (const tabId of ids) {
    const change = pending[tabId];
    list.append(element("div", { class: "card" },
      element("div", { class: "title", text: `A shared tab moved to ${hostnameOf(change.to) || "a page that cannot be shared"}` }),
      element("div", { class: "sub", text: `It was ${hostnameOf(change.from)}. The agent cannot see it until you decide.` }),
      element("div", { class: "actions" },
        change.to ? element("button", { type: "button", text: "Share the new site", onclick: () => act({ type: "zamery_browser_firefox_confirm_origin", tab_id: Number(tabId) }) }) : null,
        element("button", { type: "button", class: "danger", text: "Stop sharing this tab", onclick: () => act({ type: "zamery_browser_firefox_exclude_tab", tab_id: Number(tabId) }) }),
      ),
    ));
  }
}

async function renderPicker(status, rebinding) {
  $("#picker").classList.remove("hidden");
  const note = $("#rebind-note");
  note.classList.toggle("hidden", !rebinding);
  if (rebinding) {
    const origins = (status.rebind?.origins || []).map(hostnameOf).filter(Boolean);
    note.textContent = `${reasonText(status.reason) || "Firefox or the local bridge restarted."} Your approval is still valid until ${formatWhen(status.expires_at)}. Choose which tabs to share again${origins.length ? ` (before: ${origins.join(", ")})` : ""}.`;
  }

  const agents = status.seen_audiences || [];
  const select = $("#agent");
  const previous = select.value;
  // Rebuilding an open <select> collapses it, so only touch the options when the set of agents changed.
  const agentsKey = JSON.stringify([agents.map((entry) => [entry.audience_id, entry.label]), status.audience_id]);
  if (select.dataset.key !== agentsKey) {
    select.dataset.key = agentsKey;
    select.replaceChildren(...agents.map((entry) => element("option", { value: entry.audience_id, text: agentLabel(entry) })));
    if (status.audience_id && !agents.some((entry) => entry.audience_id === status.audience_id)) {
      select.append(element("option", { value: status.audience_id, text: "Local agent (not connected right now)" }));
    }
    select.value = [...select.options].some((option) => option.value === previous) ? previous : status.audience_id || select.options[0]?.value || "";
  }
  $("#agent-hint").textContent = agents.length === 0 && !status.audience_id
    ? "Ask your agent to check browser status first, so it appears here."
    : "Only this agent will be able to use the shared tabs.";

  if (!pickerDirty) await renderTabChoices();
  $("#duration").disabled = rebinding;
  if (rebinding) {
    const days = status.duration_days;
    $("#duration").value = status.duration_mode === "fixed" && PRESET_DAYS.has(days) ? String(days) : "custom";
    $("#custom-days").value = String(days ?? 2);
  }
  updateDurationUi(status, rebinding);
  $("#grant").disabled = busy || !select.value;
  $("#grant").textContent = rebinding ? "Share again" : "Share selected";
}

async function renderTabChoices() {
  const current = await browser.windows.getCurrent().catch(() => null);
  const tabs = current ? await browser.tabs.query({ windowId: current.id }) : [];
  const list = $("#tabs");
  const checked = new Set([...list.querySelectorAll("input:checked")].map((input) => input.value));
  const firstRender = list.children.length === 0;
  list.replaceChildren();
  const incognito = current?.incognito === true;
  for (const tab of tabs) {
    let eligible = !incognito && /^https?:/i.test(tab.url || "");
    const id = `tab-${tab.id}`;
    const input = element("input", { type: "checkbox", value: String(tab.id), id });
    input.disabled = !eligible;
    input.checked = eligible && (firstRender ? tab.active : checked.has(String(tab.id)));
    input.addEventListener("change", () => { pickerDirty = true; });
    list.append(element("label", { for: id },
      input,
      element("span", {},
        element("div", { class: "title", text: tab.title || hostnameOf(tab.url) || "Untitled" }),
        element("div", { class: "sub", text: eligible ? hostnameOf(tab.url) : incognito ? "Private windows can't be shared" : "This page can't be shared" }),
      ),
    ));
  }

  const groupsBlock = $("#groups-block");
  const groupsList = $("#groups");
  const groupChecked = new Set([...groupsList.querySelectorAll("input:checked")].map((input) => input.value));
  groupsList.replaceChildren();
  let groups = [];
  if (!incognito && typeof browser.tabGroups?.query === "function") {
    groups = await browser.tabGroups.query({ windowId: current.id }).catch(() => []);
  }
  groupsBlock.classList.toggle("hidden", groups.length === 0);
  for (const group of groups) {
    const members = tabs.filter((tab) => tab.groupId === group.id);
    const input = element("input", { type: "checkbox", value: String(group.id), id: `group-${group.id}` });
    input.checked = groupChecked.has(String(group.id));
    input.addEventListener("change", () => { pickerDirty = true; updateGroupPolicyVisibility(); });
    groupsList.append(element("label", { for: input.id },
      input,
      element("span", {},
        element("div", { class: "title", text: `Group: ${group.title || "(untitled)"}` }),
        element("div", { class: "sub", text: `${members.length} tab${members.length === 1 ? "" : "s"} now` }),
      ),
    ));
  }
  updateGroupPolicyVisibility();
}

function updateGroupPolicyVisibility() {
  const any = $("#groups").querySelector("input:checked");
  $("#group-policy").classList.toggle("hidden", !any);
}

function selectedDuration() {
  const value = $("#duration").value;
  if (value === "session") return { duration: { mode: "session" } };
  if (value === "custom") {
    const days = Number($("#custom-days").value);
    return { duration: { mode: "fixed", days }, allow_custom_duration: true };
  }
  return { duration: { mode: "fixed", days: Number(value) } };
}

function updateDurationUi(status, rebinding) {
  const isCustom = $("#duration").value === "custom";
  $("#custom-days").classList.toggle("hidden", !isCustom);
  $("#custom-days").disabled = rebinding;
  const { duration } = selectedDuration();
  const days = duration.mode === "fixed" ? duration.days : null;
  const valid = duration.mode === "session" || (Number.isInteger(days) && days >= 1 && days <= 30);
  if (rebinding && status?.expires_at) $("#expiry-preview").textContent = `Access ends ${formatWhen(status.expires_at)} (unchanged).`;
  else if (!valid) $("#expiry-preview").textContent = "Choose 1 to 30 days.";
  else if (days === null) $("#expiry-preview").textContent = "Access ends when you stop sharing or restart Firefox.";
  else $("#expiry-preview").textContent = `Access ends ${formatWhen(Date.now() + days * 86_400_000)}.`;
  $("#grant").disabled = busy || !valid || !$("#agent").value;
}

function render(status) {
  lastStatus = status;
  const ready = renderConnection(status);
  $("#granted").classList.add("hidden");
  $("#picker").classList.add("hidden");
  $("#error").textContent = "";

  const terminal = reasonText(status.reason);
  if (status.state === "granted") {
    renderGranted(status);
  } else if (ready && status.state === "rebind_required") {
    void renderPicker(status, true);
  } else if (ready) {
    if (status.state === "expired" || terminal) {
      $("#connection-detail").textContent = status.state === "expired" ? "Access expired. Share again to continue." : terminal;
    }
    void renderPicker(status, false);
  }

  $("#diagnostics").replaceChildren(
    element("div", {}, "Host session: ", element("code", { text: status.current_host_session_id || "none" })),
    element("div", {}, "Protocol: companion ", element("code", { text: String(status.expected_protocol_version) }), " / host ", element("code", { text: String(status.current_host_protocol_version ?? "none") })),
    element("div", {}, "Run epoch: ", element("code", { text: status.browser_run_epoch || "" })),
    element("div", {}, "State: ", element("code", { text: `${status.state}${status.reason ? ` (${status.reason})` : ""}` })),
    status.grant_id ? element("div", {}, "Grant: ", element("code", { text: `${status.grant_id} r${status.grant_revision}` })) : null,
  );
}

async function refresh() {
  try {
    render(await send({ type: "zamery_browser_firefox_auth_status" }));
  } catch (error) {
    $("#error").textContent = `Could not read companion state: ${error?.message || error}`;
  }
}

async function act(message) {
  busy = true;
  try {
    const result = await send(message);
    $("#error").textContent = result?.ok === false ? errorText(result.error) : "";
  } finally {
    busy = false;
    pickerDirty = false;
    await refresh();
  }
}

const ERRORS = {
  local_agent_not_connected: "That agent is not connected. Ask it to check browser status, then try again.",
  no_local_agent_selected: "Choose which agent to share with.",
  no_shareable_tab_selected: "Choose at least one tab to share.",
  selected_tabs_are_not_supported_web_pages: "Only normal web pages in non-private windows can be shared.",
  invalid_authorization_duration: "Choose 1 to 30 days.",
  custom_authorization_duration_requires_explicit_intent: "Pick a preset or Custom.",
  grant_already_active_revoke_first: "Sharing is already on. Stop sharing first to change it.",
  native_host_session_not_ready: "The local bridge is not connected.",
  native_host_protocol_version_mismatch: "Update the companion and the local bridge.",
  tab_groups_api_unavailable: "This Firefox does not support tab groups.",
  clock_regression_confirmation_required: "Your clock moved backwards. Tick the confirmation to continue.",
  no_pending_origin_change: "Nothing to confirm.",
  not_granted: "Sharing is not on.",
  tab_not_shareable: "That page can't be shared.",
};

function errorText(code) {
  return ERRORS[code] || `Could not complete that (${code}).`;
}

$("#duration").addEventListener("change", () => updateDurationUi(lastStatus, lastStatus?.state === "rebind_required"));
$("#custom-days").addEventListener("input", () => updateDurationUi(lastStatus, lastStatus?.state === "rebind_required"));
$("#agent").addEventListener("change", () => { $("#grant").disabled = !$("#agent").value; });

$("#grant").addEventListener("click", () => {
  const tabIds = [...$("#tabs").querySelectorAll("input:checked")].map((input) => Number(input.value));
  const groupIds = [...$("#groups").querySelectorAll("input:checked")].map((input) => Number(input.value));
  const actions = ["inspect"];
  if ($("#act-interact").checked) actions.push("interact");
  if ($("#act-capture").checked) actions.push("capture");
  if ($("#act-reorganize").checked) actions.push("reorganize");
  if ($("#act-create").checked) actions.push("create_tab", "close_owned_tab");
  const rebinding = lastStatus?.state === "rebind_required";
  void act({
    type: "zamery_browser_firefox_grant",
    audience_id: $("#agent").value,
    tab_ids: tabIds,
    group_ids: groupIds,
    group_policy: document.querySelector("input[name=group-policy]:checked")?.value,
    actions,
    ...(rebinding ? { confirm_clock_change: true } : selectedDuration()),
  });
});
$("#share-current").addEventListener("click", async () => {
  const current = await browser.windows.getCurrent().catch(() => null);
  const active = current ? await browser.tabs.query({ windowId: current.id, active: true }) : [];
  if (active[0]) void act({ type: "zamery_browser_firefox_add_tabs", tab_ids: [active[0].id] });
});
$("#revoke").addEventListener("click", () => void act({ type: "zamery_browser_firefox_revoke" }));
$("#takeover").addEventListener("click", () => void act({ type: "zamery_browser_firefox_takeover" }));
$("#resume").addEventListener("click", () => void act({ type: "zamery_browser_firefox_resume" }));

void refresh();
setInterval(() => { if (!busy) void refresh(); }, 2000);
