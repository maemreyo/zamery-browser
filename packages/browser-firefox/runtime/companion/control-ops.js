// Tab lifecycle and tab-group operations. Loaded after background.js, which owns authority state
// (`binding`, `control`, `Policy`, `contextAuthorization`, ...). Every topology event here is treated as an
// invalidation and a re-query trigger; nothing in this file derives authority from an event.

const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const GROUP_TITLE_MAX_CHARS = 64;
const MAX_GROUP_MUTATION_TABS = 32;
const GROUP_NONE = -1;

let topologyRevision = 0;

function bumpTopology() {
  topologyRevision += 1;
}

function groupsApiAvailable() {
  return typeof browser.tabGroups?.query === "function"
    && typeof browser.tabGroups?.get === "function"
    && typeof browser.tabs?.group === "function"
    && typeof browser.tabs?.ungroup === "function";
}

function requireGroupsApi() {
  if (!groupsApiAvailable()) throw newError("UNSUPPORTED_CAPABILITY", "this Firefox build does not expose tab groups", "tab_groups_api_unavailable");
}

/** Writes are refused while the human is driving, regardless of the tab being written. */
function requireNotUserControl() {
  if (control.state === "user_control") throw denial("BROWSER_AUTHORIZATION_REQUIRED", "user_control");
}

function requireContextIds(value, { max = MAX_GROUP_MUTATION_TABS } = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw newError("INVALID_ARGUMENT", `context_ids must list 1..${max} contexts`, "invalid_context_ids");
  }
  const unique = [...new Set(value.map((entry) => String(entry)))];
  return unique.map((contextId) => tabIdFromContext(contextId));
}

function cleanGroupTitle(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, GROUP_TITLE_MAX_CHARS);
}

function groupColor(value) {
  if (!GROUP_COLORS.includes(value)) throw newError("INVALID_ARGUMENT", "unsupported group color", "invalid_group_color");
  return value;
}

// ---- tab operations ---------------------------------------------------------------------------------

function ownedOrClaimedForWrite(contextId, audienceId, tabId) {
  requireNotUserControl();
  if (ownedTabIds.has(tabId)) return;
  const claimed = control.state === "agent_claimed"
    && control.claimedContextId === contextId
    && control.claimedAudienceId === audienceId;
  if (!claimed) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "claim_required");
}

async function navigateTab(params, audienceId, { reload = false } = {}) {
  const contextId = String(params.context_id || "");
  const action = ownedTabIds.has(tabIdFromContext(contextId)) ? "create_tab" : "interact";
  const { tabId, tab } = await contextAuthorization(contextId, action);
  ownedOrClaimedForWrite(contextId, audienceId, tabId);
  if (!ownedTabIds.has(tabId)) await requireFocusedTarget(tab);

  const key = String(tabId);
  const entry = binding.scope.tabs[key];
  if (reload) {
    await browser.tabs.reload(tabId);
    lastAgentMutationAt = Date.now();
    return { outcome: "completed", context_id: contextId, ownership: ownedTabIds.has(tabId) ? "provider-owned" : "user-owned", completed_substeps: ["tab_reloaded"] };
  }

  const rawUrl = String(params.url || "");
  const destination = originForUrl(rawUrl);
  if (!destination) throw denial("BROWSER_CONTEXT_UNAVAILABLE", "unsupported_destination_scheme", "only http(s) destinations may be opened");
  const owned = ownedTabIds.has(tabId);
  if (!owned && destination !== entry.origin) {
    // A user's tab keeps its recorded origin: moving it to another site is the user's decision.
    throw denial("BROWSER_AUTHORIZATION_REQUIRED", "cross_origin_navigation_requires_user");
  }
  const previousOrigin = entry.origin;
  if (owned) {
    // Declare the intended origin first so the resulting tabs.onUpdated is not mistaken for a site change.
    binding.scope.tabs = { ...binding.scope.tabs, [key]: { ...entry, origin: destination } };
    delete pendingOriginChanges[key];
  }
  try {
    await browser.tabs.update(tabId, { url: rawUrl });
  } catch (error) {
    if (owned) binding.scope.tabs = { ...binding.scope.tabs, [key]: { ...entry, origin: previousOrigin } };
    throw error;
  }
  lastAgentMutationAt = Date.now();
  dropTabCaches(tabId);
  if (owned) bumpRevision();
  return { outcome: "completed", context_id: contextId, ownership: owned ? "provider-owned" : "user-owned", completed_substeps: ["tab_navigated"] };
}

async function activateTab(params) {
  const contextId = String(params.context_id || "");
  const { tabId, tab } = await contextAuthorization(contextId, "interact");
  requireNotUserControl();
  const substeps = [];
  await browser.tabs.update(tabId, { active: true });
  substeps.push("tab_activated");
  await browser.windows.update(tab.windowId, { focused: true });
  substeps.push("window_focused");
  return { outcome: "completed", context_id: contextId, ownership: ownedTabIds.has(tabId) ? "provider-owned" : "user-owned", completed_substeps: substeps };
}

// ---- tab groups ---------------------------------------------------------------------------------------

function newGroupHandle() {
  return `grp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function scopeGroup(handle) {
  const group = binding?.scope?.groups?.[String(handle)];
  if (!group) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "outside_scope", "tab group is outside the current authorization scope");
  return group;
}

function authorizedMemberTabs(tabs) {
  return tabs.filter((tab) => {
    const entry = binding.scope.tabs[String(tab.id)];
    if (!entry) return false;
    return Policy.evaluateTabAccess({ scope: binding.scope, actions: binding.actions, pendingOrigins: pendingOriginChanges }, tab, "inspect").ok;
  });
}

function removeGroupFromScope(handle, reason) {
  if (!binding?.scope?.groups?.[handle]) return;
  const { [handle]: _gone, ...groups } = binding.scope.groups;
  const tabs = {};
  for (const [tabId, entry] of Object.entries(binding.scope.tabs)) if (entry.viaGroup !== handle) tabs[tabId] = entry;
  const removedTabIds = Object.keys(binding.scope.tabs).filter((tabId) => !tabs[tabId]).map(Number);
  binding.scope.groups = groups;
  binding.scope.tabs = tabs;
  bumpTopology();
  bumpRevision();
  for (const tabId of removedTabIds) {
    ownedTabIds.delete(tabId);
    applyControl({ type: "context_gone", contextId: contextIdFor(tabId) });
    dropTabCaches(tabId);
  }
  if (Object.keys(binding.scope.tabs).length === 0) endAuthority(reason === "group_removed" ? "authorized_group_removed" : "authorized_tabs_removed");
}

/** Observe a scoped group: re-query native state, drop it from scope if it vanished. */
async function observeGroup(handle) {
  const scoped = scopeGroup(handle);
  let native;
  try {
    native = await browser.tabGroups.get(scoped.nativeGroupId);
  } catch {
    removeGroupFromScope(handle, "group_removed");
    throw newError("BROWSER_CONTEXT_GONE", "tab group no longer exists", "group_gone");
  }
  const members = await browser.tabs.query({ groupId: scoped.nativeGroupId });
  scoped.windowId = native.windowId ?? scoped.windowId;
  return { scoped, native, members };
}

function groupView(handle, scoped, native, members) {
  const authorized = authorizedMemberTabs(members);
  return {
    handle,
    revision: scoped.revision,
    window_id: native.windowId ?? null,
    title: cleanGroupTitle(native.title),
    color: native.color,
    collapsed: native.collapsed === true,
    member_context_ids: authorized.map((tab) => contextIdFor(tab.id)),
    incomplete_membership: authorized.length < members.length,
    policy: scoped.policy,
  };
}

async function listGroups() {
  requireGroupsApi();
  const out = [];
  for (const handle of Object.keys(binding.scope.groups)) {
    try {
      const { scoped, native, members } = await observeGroup(handle);
      out.push(groupView(handle, scoped, native, members));
    } catch (error) {
      if (error?.reason !== "group_gone") throw error;
    }
  }
  return { groups: out, topology_revision: topologyRevision };
}

async function getGroup(params) {
  requireGroupsApi();
  const { scoped, native, members } = await observeGroup(String(params.handle || ""));
  return { group: groupView(String(params.handle), scoped, native, members), topology_revision: topologyRevision };
}

/** Group-wide changes affect every member, so every member must be independently authorized for `reorganize`. */
async function requireCompleteMembership(members) {
  const authorized = authorizedMemberTabs(members);
  if (authorized.length < members.length) {
    throw denial("BROWSER_AUTHORIZATION_REQUIRED", "incomplete_membership_structural_change_refused");
  }
  for (const tab of members) await contextAuthorization(contextIdFor(tab.id), "reorganize");
}

async function requireGroupableTabs(tabIds, { sameWindowAs } = {}) {
  const tabs = [];
  for (const tabId of tabIds) {
    const { tab } = await contextAuthorization(contextIdFor(tabId), "reorganize");
    if (tab.pinned === true) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "pinned_tab_refused", "grouping would unpin a pinned tab");
    tabs.push(tab);
  }
  const windowIds = new Set(tabs.map((tab) => tab.windowId));
  if (windowIds.size > 1 || (sameWindowAs !== undefined && !windowIds.has(sameWindowAs))) {
    throw denial("BROWSER_AUTHORIZATION_REQUIRED", "cross_window_grouping_refused");
  }
  return tabs;
}

async function createGroup(params) {
  requireGroupsApi();
  requireNotUserControl();
  const tabIds = requireContextIds(params.context_ids);
  const tabs = await requireGroupableTabs(tabIds);
  const title = params.title === undefined ? undefined : cleanGroupTitle(params.title);
  const color = params.color === undefined ? undefined : groupColor(params.color);
  const completed = [];

  const nativeGroupId = await browser.tabs.group({ tabIds, createProperties: { windowId: tabs[0].windowId } });
  completed.push("group_created", "tabs_grouped");
  const handle = newGroupHandle();
  binding.scope.groups = {
    ...binding.scope.groups,
    [handle]: { nativeGroupId, policy: "membership_snapshot", windowId: tabs[0].windowId, revision: 1 },
  };
  // The group inherits no authority: only the tabs the agent already held stay authorized, as direct entries.
  bumpTopology();
  bumpRevision();
  if (title !== undefined || color !== undefined) {
    try {
      await browser.tabGroups.update(nativeGroupId, { ...(title !== undefined ? { title } : {}), ...(color !== undefined ? { color } : {}) });
      completed.push("group_updated");
    } catch (error) {
      return {
        outcome: "partially_applied",
        error: { code: "BROWSER_REQUEST_FAILED", reason: "group_update_failed_after_create", message: String(error?.message || error).slice(0, 200) },
        completed_substeps: completed,
        group_handle: handle,
      };
    }
  }
  const { scoped, native, members } = await observeGroup(handle);
  return { outcome: "completed", group_handle: handle, group_revision: scoped.revision, group: groupView(handle, scoped, native, members), completed_substeps: completed, member_context_ids: tabIds.map(contextIdFor) };
}

async function updateGroup(params) {
  requireGroupsApi();
  requireNotUserControl();
  const handle = String(params.handle || "");
  const { scoped, members } = await observeGroup(handle);
  await requireCompleteMembership(members);
  const patch = {};
  if (params.title !== undefined) patch.title = cleanGroupTitle(params.title);
  if (params.color !== undefined) patch.color = groupColor(params.color);
  if (params.collapsed !== undefined) patch.collapsed = params.collapsed === true;
  if (Object.keys(patch).length === 0) throw newError("INVALID_ARGUMENT", "no group property to update", "empty_group_update");
  await browser.tabGroups.update(scoped.nativeGroupId, patch);
  scoped.revision += 1;
  bumpTopology();
  const fresh = await observeGroup(handle);
  return { outcome: "completed", group_handle: handle, group_revision: fresh.scoped.revision, group: groupView(handle, fresh.scoped, fresh.native, fresh.members), completed_substeps: ["group_updated"] };
}

async function addTabsToGroup(params) {
  requireGroupsApi();
  requireNotUserControl();
  const handle = String(params.handle || "");
  const tabIds = requireContextIds(params.context_ids);
  const { scoped, members } = await observeGroup(handle);
  // The agent can only add tabs it already holds authority over; moving a tab into a group never grants authority.
  await requireGroupableTabs(tabIds, { sameWindowAs: scoped.windowId });
  await browser.tabs.group({ groupId: scoped.nativeGroupId, tabIds });
  scoped.revision += 1;
  for (const tabId of tabIds) agentMovedTabs.add(tabId);
  bumpTopology();
  const fresh = await observeGroup(handle);
  void members;
  return { outcome: "completed", group_handle: handle, group_revision: fresh.scoped.revision, group: groupView(handle, fresh.scoped, fresh.native, fresh.members), completed_substeps: ["tabs_grouped"], member_context_ids: tabIds.map(contextIdFor) };
}

async function removeTabsFromGroup(params) {
  requireGroupsApi();
  requireNotUserControl();
  const handle = String(params.handle || "");
  const tabIds = requireContextIds(params.context_ids);
  const { scoped, members } = await observeGroup(handle);
  const memberIds = new Set(members.map((tab) => tab.id));
  for (const tabId of tabIds) {
    await contextAuthorization(contextIdFor(tabId), "reorganize");
    if (!memberIds.has(tabId)) throw newError("INVALID_ARGUMENT", "tab is not a member of the group", "not_a_group_member");
  }
  await browser.tabs.ungroup(tabIds);
  scoped.revision += 1;
  bumpTopology();
  let group = null;
  // Removing the last member deletes the group; the event handler may already have withdrawn it from scope.
  if (binding?.scope?.groups?.[handle]) {
    try {
      const fresh = await observeGroup(handle);
      group = groupView(handle, fresh.scoped, fresh.native, fresh.members);
    } catch (error) {
      if (error?.reason !== "group_gone" && error?.reason !== "outside_scope") throw error;
    }
  }
  return { outcome: "completed", group_handle: handle, group_revision: scoped.revision, group, completed_substeps: ["tabs_ungrouped"] };
}

async function moveGroup(params) {
  requireGroupsApi();
  requireNotUserControl();
  const handle = String(params.handle || "");
  const index = Number(params.index);
  if (!Number.isSafeInteger(index) || index < -1) throw newError("INVALID_ARGUMENT", "index must be an integer >= -1", "invalid_index");
  const { scoped, members } = await observeGroup(handle);
  await requireCompleteMembership(members);
  if (params.window_id !== undefined && Number(params.window_id) !== scoped.windowId) {
    throw denial("BROWSER_AUTHORIZATION_REQUIRED", "cross_window_group_move_refused");
  }
  await browser.tabGroups.move(scoped.nativeGroupId, { index });
  scoped.revision += 1;
  bumpTopology();
  const fresh = await observeGroup(handle);
  return { outcome: "completed", group_handle: handle, group_revision: fresh.scoped.revision, group: groupView(handle, fresh.scoped, fresh.native, fresh.members), completed_substeps: ["group_moved"] };
}

/** Firefox has no group-activation API: focus an explicit authorized member and say which one. */
async function activateGroup(params) {
  requireGroupsApi();
  requireNotUserControl();
  const handle = String(params.handle || "");
  const { scoped, members } = await observeGroup(handle);
  const authorized = authorizedMemberTabs(members);
  let target;
  if (params.context_id !== undefined) {
    const tabId = tabIdFromContext(String(params.context_id));
    target = authorized.find((tab) => tab.id === tabId);
    if (!target) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "outside_scope", "context is not an authorized member of the group");
  } else {
    target = authorized.find((tab) => tab.active) || authorized[0];
  }
  if (!target) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "outside_scope", "the group has no authorized member to focus");
  await contextAuthorization(contextIdFor(target.id), "interact");
  const substeps = [];
  const native = await browser.tabGroups.get(scoped.nativeGroupId);
  if (native.collapsed === true) {
    // Focusing a collapsed group's member would not show it; expanding is part of the requested activation.
    await browser.tabGroups.update(scoped.nativeGroupId, { collapsed: false });
    substeps.push("group_expanded");
  }
  await browser.tabs.update(target.id, { active: true });
  substeps.push("tab_activated");
  await browser.windows.update(target.windowId, { focused: true });
  substeps.push("window_focused");
  const fresh = await observeGroup(handle);
  return { outcome: "completed", group_handle: handle, group_revision: fresh.scoped.revision, group: groupView(handle, fresh.scoped, fresh.native, fresh.members), focused_context_id: contextIdFor(target.id), completed_substeps: substeps };
}

// ---- dispatch hook used by background.js ----------------------------------------------------------------

async function executeExtendedRequest(op, params, message) {
  const audienceId = requestAudienceId(message);
  switch (op) {
    case "navigate_tab": return { value: await navigateTab(params, audienceId) };
    case "reload_tab": return { value: await navigateTab(params, audienceId, { reload: true }) };
    case "activate_tab": return { value: await activateTab(params) };
    case "group_list": return { value: await listGroups() };
    case "group_get": return { value: await getGroup(params) };
    case "group_create": return { value: await createGroup(params) };
    case "group_update": return { value: await updateGroup(params) };
    case "group_add_tabs": return { value: await addTabsToGroup(params) };
    case "group_remove_tabs": return { value: await removeTabsFromGroup(params) };
    case "group_move": return { value: await moveGroup(params) };
    case "group_activate": return { value: await activateGroup(params) };
    default: return undefined;
  }
}

// ---- topology observation -----------------------------------------------------------------------------------
// Firefox documents no total ordering across tab/group events, so every event only invalidates and re-queries.

const agentMovedTabs = new Set();

/**
 * Re-establish scope derived from groups after any topology change.
 * - membership_snapshot: nothing to add. Access is evaluated live from tab.groupId, so leaving withdraws access.
 * - follow_group: human-origin members join after eligibility checks; tabs the agent moved in never join here.
 */
async function reconcileGroupsAfterEvent(reason, tabId) {
  bumpTopology();
  if (!binding || !groupsApiAvailable()) return;
  // Group-derived access ends when a tab leaves its group; re-entry never silently restores it.
  for (const [tabIdKey, entry] of Object.entries(binding.scope.tabs)) {
    if (!binding) return;
    if (!entry.viaGroup) continue;
    const group = binding.scope.groups[entry.viaGroup];
    const tab = await browser.tabs.get(Number(tabIdKey)).catch(() => null);
    if (!tab) removeTabFromScope(Number(tabIdKey), "tab_closed");
    else if (!group || tab.groupId !== group.nativeGroupId) removeTabFromScope(Number(tabIdKey), "left_group");
  }
  if (!binding) return;
  for (const [handle, scoped] of Object.entries(binding.scope.groups)) {
    scoped.revision += 1;
    let native;
    try {
      native = await browser.tabGroups.get(scoped.nativeGroupId);
    } catch {
      removeGroupFromScope(handle, "group_removed");
      continue;
    }
    scoped.windowId = native.windowId ?? scoped.windowId;
    if (scoped.policy !== "follow_group") continue;
    const members = await browser.tabs.query({ groupId: scoped.nativeGroupId });
    let added = false;
    for (const tab of members) {
      if (binding.scope.tabs[String(tab.id)] || agentMovedTabs.has(tab.id)) continue;
      const eligible = await eligibleTabForGrant(tab.id);
      if (!eligible) continue;
      binding.scope.tabs = {
        ...binding.scope.tabs,
        [String(tab.id)]: { origin: eligible.origin, partition: eligible.tab.cookieStoreId ?? null, viaGroup: handle },
      };
      added = true;
    }
    if (added) bumpRevision();
  }
  void reason;
  void tabId;
}

function onGroupEvent() {
  void reconcileGroupsAfterEvent("tab_group_event");
}

if (groupsApiAvailable()) {
  for (const name of ["onCreated", "onUpdated", "onMoved", "onRemoved"]) browser.tabGroups[name]?.addListener(onGroupEvent);
}
for (const name of ["onCreated", "onMoved", "onAttached", "onDetached"]) {
  browser.tabs[name]?.addListener((arg) => {
    bumpTopology();
    if (groupsApiAvailable() && binding && Object.keys(binding.scope.groups).length > 0) void reconcileGroupsAfterEvent(`tab_${name}`, typeof arg === "number" ? arg : arg?.id);
  });
}
browser.windows.onRemoved?.addListener(() => {
  bumpTopology();
  if (binding) void reconcileGroupsAfterEvent("window_removed");
});
