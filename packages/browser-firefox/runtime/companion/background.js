const HOST_NAME = "com.zamery.browser_firefox";
const PROTOCOL_VERSION = 2;
const CONSENT_STORAGE_KEY = "zameryBrowserFirefoxConsentV1";
const MAX_COMPLETED_REQUESTS = 512;
const MAX_SEEN_AUDIENCES = 16;
const SEEN_AUDIENCE_TTL_MS = 10 * 60 * 1000;
const AUTHORITY_TICK_MS = 30_000;
const CONSENT_LAST_SEEN_PERSIST_MS = 5 * 60 * 1000;
const PRIMARY_DOCUMENT_TARGET = { frameId: 0 };
const A1_DEVELOPMENT_EXTENSION_ID = "zamery-live-browser-v0c@zamery.local";
const A1_REGISTRY_TTL_MS = 5 * 60 * 1000;
const A1_MAX_ASSET_REFS = 256;
const A1_MAX_ACTIVE_TRANSFERS = 8;
const A1_CONTENT_RPC_TIMEOUT_MS = 5_000;
const ASSET_V1_REGISTRY_TTL_MS = 5 * 60 * 1000;
const ASSET_V1_TRANSFER_TTL_MS = 2 * 60 * 1000;
const ASSET_V1_MAX_REFS = 256;
const ASSET_V1_MAX_ACTIVE_TRANSFERS = 8;
const ASSET_DISCOVERY_CONTENT_RPC_TIMEOUT_MS = 5_000;
const ASSET_TRANSFER_CONTENT_RPC_TIMEOUT_MS = 35_000;
// A human action within this window of an agent mutation is attributed to the agent, not the user.
const AGENT_NAVIGATION_ATTRIBUTION_MS = 10_000;
const AGENT_ACTIVATION_ATTRIBUTION_MS = 3_000;

const MUTATION_OPS = new Set([
  "act",
  "create_tab",
  "close_owned_tab",
  "navigate_tab",
  "reload_tab",
  "activate_tab",
  "group_create",
  "group_update",
  "group_add_tabs",
  "group_remove_tabs",
  "group_move",
  "group_activate",
]);

const Policy = globalThis.ZameryPolicy;
const browserRunEpoch = crypto.randomUUID();

let nativePort;
let profileId = "";
let browserInstanceId = "";
const ownedTabIds = new Set();
const mutationTails = new Map();
const completedRequests = new Map();
const inFlightRequests = new Map();
const cancelledRequests = new Set();
const requestPhases = new Map();
const a1AssetRefs = new Map();
const assetV1Refs = new Map();
const assetV1Transfers = new Map();
const assetV1RequestContexts = new Map();
const a1Transfers = new Map();
const a1RequestContexts = new Map();
let nativeConnectAttempt = 0;
let heartbeatTimer = null;
let authorityTimer = null;
let currentHostSessionId = null;
let currentHostProtocolVersion = null;

// ConsentGrant (what the user agreed to; fixed-duration consent survives restarts) and LiveBinding
// (which concrete tabs/groups, for which host session, right now) are different facts and live apart.
let consent = null;
let binding = null;
let control = Policy.createControl();
let lastEnd = null;
let consentPersistedSeenAt = 0;
const seenAudiences = new Map();
const pendingOriginChanges = {};
const interactionGenerations = new Map();
let lastAgentMutationAt = 0;
let agentActivationUntil = 0;

/** The agent's own tab/window activation must not be mistaken for the user switching away. */
function markAgentActivation() {
  agentActivationUntil = Date.now() + AGENT_ACTIVATION_ATTRIBUTION_MS;
}

function requestAudienceId(message) {
  const value = String(message?.audience_id || "").trim();
  return value || "anonymous-local-client";
}

function mutationFingerprint(message) {
  return JSON.stringify({ audience_id: requestAudienceId(message), op: message.op, params: message.params || {} });
}

function newError(code, message, reason, extra = {}) {
  const error = new Error(message);
  error.code = code;
  if (reason) error.reason = reason;
  return Object.assign(error, extra);
}

function denial(code, reason, message) {
  return newError(code, message || `Firefox companion denied the request: ${reason}`, reason);
}

function originForUrl(url) {
  return Policy.originForUrl(url);
}

// ---- consent persistence & authority lifecycle -----------------------------------------------

function clearCachesForAuthorityChange() {
  if (typeof dropAllArtifacts === "function") dropAllArtifacts();
  completedRequests.clear();
  assetV1Refs.clear();
  assetV1Transfers.clear();
  assetV1RequestContexts.clear();
  a1AssetRefs.clear();
  a1Transfers.clear();
  a1RequestContexts.clear();
  for (const key of Object.keys(pendingOriginChanges)) delete pendingOriginChanges[key];
}

async function persistConsent() {
  try {
    if (consent && consent.mode === "fixed") {
      await browser.storage.local.set({ [CONSENT_STORAGE_KEY]: consent });
      consentPersistedSeenAt = Date.now();
    } else {
      await browser.storage.local.remove(CONSENT_STORAGE_KEY);
    }
  } catch (error) {
    console.error("[zamery-browser-firefox] consent persistence failed", error);
  }
}

function applyControl(event) {
  const result = Policy.transition(control, event, Date.now());
  if (result.ok) control = result.control;
  return result;
}

/** The user (or expiry) ended consent entirely. */
function endAuthority(reason, state = "revoked") {
  consent = null;
  binding = null;
  lastEnd = { state, reason, at: Date.now() };
  applyControl({ type: "revoke", reason });
  clearCachesForAuthorityChange();
  void persistConsent();
}

/** The live binding is gone but fixed-duration consent may still be valid; the user must rebind explicitly. */
function dropBinding(reason) {
  if (consent && consent.mode === "fixed" && !Policy.consentExpired(consent, Date.now())) {
    binding = null;
    lastEnd = { state: "rebind_required", reason, at: Date.now() };
    applyControl({ type: "rebind_required", reason });
    clearCachesForAuthorityChange();
    return;
  }
  endAuthority(reason);
}

function bumpRevision() {
  if (!binding || !consent) return;
  consent = { ...consent, grantRevision: consent.grantRevision + 1 };
  binding.grantRevision = consent.grantRevision;
  void persistConsent();
}

function monotonicExpired() {
  return binding?.monotonicDeadline != null && performance.now() >= binding.monotonicDeadline;
}

/** Normalize authority against the clock, host session and protocol before anything reads or writes it. */
function ensureAuthorityCurrent() {
  const now = Date.now();
  if (!consent) return;
  if (Policy.consentExpired(consent, now) || (binding && monotonicExpired())) {
    endAuthority("authorization_expired", "expired");
    return;
  }
  if (Policy.clockRegressed(consent, now)) {
    dropBinding("clock_regression_revalidation_required");
    return;
  }
  if (binding) {
    if (currentHostProtocolVersion !== PROTOCOL_VERSION) dropBinding("native_host_protocol_mismatch");
    else if (!currentHostSessionId || binding.hostSessionId !== currentHostSessionId) dropBinding("native_host_session_changed");
  }
}

// A lineage names one concrete LiveBinding instance and the audience that holds it. Scope edits within the same
// binding (a tab closed, a tab created) do not end a request's authority; revoke, expiry, rebind and a new grant do.
function lineageNow(audienceId) {
  return binding
    ? { bindingInstanceId: binding.instanceId, audienceId: audienceId ?? binding.audienceId }
    : null;
}

function lineageCurrent(lineage) {
  ensureAuthorityCurrent();
  return Boolean(
    lineage
    && binding
    && binding.instanceId === lineage.bindingInstanceId
    && binding.audienceId === lineage.audienceId,
  );
}

function authorizedTabIds() {
  return new Set(Object.keys(binding?.scope?.tabs || {}).map(Number));
}

function recordAudience(audienceId, label) {
  if (!audienceId || audienceId === "anonymous-local-client") return;
  const now = Date.now();
  for (const [id, entry] of seenAudiences) if (now - entry.last_seen > SEEN_AUDIENCE_TTL_MS) seenAudiences.delete(id);
  const previous = seenAudiences.get(audienceId);
  const cleanLabel = typeof label === "string" ? label.replace(/[^\w .:@/-]/g, "").slice(0, 48) : "";
  seenAudiences.set(audienceId, { first_seen: previous?.first_seen ?? now, last_seen: now, label: cleanLabel || previous?.label || "" });
  while (seenAudiences.size > MAX_SEEN_AUDIENCES) seenAudiences.delete(seenAudiences.keys().next().value);
}

async function loadStoredConsent() {
  try {
    const stored = await browser.storage.local.get(CONSENT_STORAGE_KEY);
    const parsed = Policy.parseStoredConsent(stored[CONSENT_STORAGE_KEY]);
    if (!parsed || parsed.trustedProfileId !== profileId) {
      if (stored[CONSENT_STORAGE_KEY]) await browser.storage.local.remove(CONSENT_STORAGE_KEY);
      return;
    }
    const now = Date.now();
    if (Policy.consentExpired(parsed, now)) {
      lastEnd = { state: "expired", reason: "authorization_expired", at: now };
      await browser.storage.local.remove(CONSENT_STORAGE_KEY);
      return;
    }
    consent = parsed;
    binding = null;
    lastEnd = { state: "rebind_required", reason: Policy.clockRegressed(parsed, now) ? "clock_regression_revalidation_required" : "restart", at: now };
    applyControl({ type: "rebind_required", reason: "restart" });
  } catch (error) {
    console.error("[zamery-browser-firefox] consent load failed", error);
  }
}

function authorityTick() {
  ensureAuthorityCurrent();
  if (consent && consent.mode === "fixed" && Date.now() - consentPersistedSeenAt >= CONSENT_LAST_SEEN_PERSIST_MS) {
    // Only ever move lastSeenAt forward so a regressed clock cannot launder itself.
    consent = { ...consent, lastSeenAt: Math.max(consent.lastSeenAt, Date.now()) };
    void persistConsent();
  }
}

// ---- authorization status ------------------------------------------------------------------

function controlSummary(forAudienceId) {
  const mine = !binding || forAudienceId == null || binding.audienceId === forAudienceId;
  return {
    state: control.state,
    claim_generation: control.claimGeneration,
    claimed_context_id: mine ? control.claimedContextId : null,
    claimed_by_you: Boolean(mine && control.claimedAudienceId && control.claimedAudienceId === forAudienceId),
    reason: control.reason,
    resume_requested: control.resumeRequested,
  };
}

function authorizationStatus(options = {}) {
  ensureAuthorityCurrent();
  const detail = options.detail === "popup" ? "popup" : "consumer";
  const audienceId = options.audienceId ?? null;
  const protocolCompatible = currentHostProtocolVersion === PROTOCOL_VERSION;
  const visible = detail === "popup" || !binding || binding.audienceId === audienceId;
  let state = "revoked";
  let reason = lastEnd?.reason ?? null;
  if (consent && binding && visible) state = "granted";
  else if (consent && !binding) state = "rebind_required";
  else if (consent && binding && !visible) { state = "revoked"; reason = "bound_to_other_consumer"; }
  else if (lastEnd?.state === "expired") { state = "expired"; reason = lastEnd.reason; }
  const granted = state === "granted";
  const summary = {
    state,
    reason,
    current_host_session_id: currentHostSessionId,
    granted_host_session_id: granted ? binding.hostSessionId : null,
    browser_run_epoch: browserRunEpoch,
    grant_id: granted || (detail === "popup" && consent) ? consent.grantId : null,
    binding_token: granted ? binding.instanceId : null,
    grant_revision: consent ? consent.grantRevision : 0,
    granted_at: consent ? consent.issuedAt : null,
    expires_at: consent ? consent.expiresAt : null,
    duration_mode: consent ? consent.mode : null,
    duration_days: consent ? consent.durationDays : null,
    scope_kind: granted ? binding.scope.kind : consent ? consent.scopeSummary.kind : null,
    scope_count: granted ? Object.keys(binding.scope.tabs).length : 0,
    actions: granted ? [...binding.actions] : [],
    group_policy: consent ? consent.groupPolicy : null,
    audience_bound: Boolean(consent?.enrolledConsumerId),
    expected_protocol_version: PROTOCOL_VERSION,
    current_host_protocol_version: currentHostProtocolVersion,
    protocol_compatible: protocolCompatible,
    control: controlSummary(audienceId),
  };
  if (detail === "popup") {
    return {
      ...summary,
      audience_id: consent?.enrolledConsumerId ?? null,
      handoff_note: control.state === "user_control" && control.reason === "agent_requested" ? handoffNote : "",
      rebind: consent && !binding ? { origins: consent.scopeSummary.origins, count: consent.scopeSummary.count } : null,
      pending_origin_changes: { ...pendingOriginChanges },
      seen_audiences: [...seenAudiences.entries()].map(([id, entry]) => ({ audience_id: id, ...entry })),
      scope_tabs: granted ? Object.entries(binding.scope.tabs).map(([tabId, entry]) => ({ tab_id: Number(tabId), origin: entry.origin, via_group: entry.viaGroup ?? null })) : [],
      scope_groups: granted ? Object.entries(binding.scope.groups).map(([handle, group]) => ({ handle, policy: group.policy })) : [],
    };
  }
  return summary;
}

/** Throws unless the request's audience currently holds a live binding; returns the lineage to re-check later. */
function authorizeRequest(message) {
  ensureAuthorityCurrent();
  if (currentHostSessionId && currentHostProtocolVersion !== PROTOCOL_VERSION) {
    throw newError(
      "BROWSER_PROTOCOL_MISMATCH",
      `Firefox companion protocol mismatch: host=${currentHostProtocolVersion} companion=${PROTOCOL_VERSION}`,
      "native_host_protocol_version_mismatch",
    );
  }
  if (!consent) throw denial("BROWSER_AUTHORIZATION_REQUIRED", currentHostSessionId ? "current_host_session_not_granted" : "native_host_session_not_ready", "Firefox companion authorization is not granted");
  if (!binding) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "rebind_required", "Firefox companion needs the user to re-select shared tabs");
  if (binding.audienceId !== requestAudienceId(message)) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "audience_mismatch", "Firefox authorization is bound to another local consumer");
  return lineageNow(binding.audienceId);
}

function currentAudience() {
  return binding?.audienceId ?? null;
}

async function contextAuthorization(contextId, action = "inspect") {
  const tabId = tabIdFromContext(contextId);
  ensureAuthorityCurrent();
  if (!binding) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "rebind_required");
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) {
    if (binding.scope.tabs[String(tabId)]) removeTabFromScope(tabId, "tab_closed");
    throw newError("BROWSER_CONTEXT_GONE", "Firefox tab is no longer available", "tab_closed");
  }
  const verdict = Policy.evaluateTabAccess({ scope: binding.scope, actions: binding.actions, pendingOrigins: pendingOriginChanges }, tab, action);
  if (!verdict.ok) {
    // Leaving the authorized group ends group-derived access for good: re-entering does not restore it.
    if (verdict.reason === "left_authorized_group") removeTabFromScope(tabId, "left_group");
    throw denial(verdict.code, verdict.reason);
  }
  return { tabId, tab };
}

function removeTabFromScope(tabId, reason) {
  if (!binding) return;
  const key = String(tabId);
  if (binding.scope.tabs[key]) {
    const { [key]: _removed, ...rest } = binding.scope.tabs;
    binding.scope.tabs = rest;
    delete pendingOriginChanges[key];
    bumpRevision();
  }
  ownedTabIds.delete(tabId);
  interactionGenerations.delete(tabId);
  applyControl({ type: "context_gone", contextId: contextIdFor(tabId) });
  dropTabCaches(tabId);
  if (binding && Object.keys(binding.scope.tabs).length === 0) endAuthority(reason === "tab_closed" ? "authorized_tabs_closed" : "authorized_tabs_removed");
}

function dropTabCaches(tabId) {
  for (const [ref, asset] of assetV1Refs) if (asset.tab_id === tabId) assetV1Refs.delete(ref);
  for (const [handle, transfer] of assetV1Transfers) if (transfer.tab_id === tabId) assetV1Transfers.delete(handle);
  for (const [requestId, target] of assetV1RequestContexts) if (target.tab_id === tabId) assetV1RequestContexts.delete(requestId);
  for (const [ref, asset] of a1AssetRefs) if (asset.tab_id === tabId) a1AssetRefs.delete(ref);
  for (const [handle, transfer] of a1Transfers) if (transfer.tab_id === tabId) a1Transfers.delete(handle);
}

// ---- identity & native transport ---------------------------------------------------------------

async function bootstrapIdentity() {
  try {
    const stored = await browser.storage.local.get([
      "zameryBrowserFirefoxProfileId",
      "zameryBrowserFirefoxBrowserInstanceId",
      "zameryV0cProfileId",
      "zameryV0cBrowserInstanceId",
    ]);
    profileId = stored.zameryBrowserFirefoxProfileId || stored.zameryV0cProfileId || crypto.randomUUID();
    browserInstanceId = stored.zameryBrowserFirefoxBrowserInstanceId || stored.zameryV0cBrowserInstanceId || crypto.randomUUID();
    await browser.storage.local.set({
      zameryBrowserFirefoxProfileId: profileId,
      zameryBrowserFirefoxBrowserInstanceId: browserInstanceId,
    });
  } catch (error) {
    console.error("[zamery-browser-firefox] identity bootstrap failed", error);
    profileId ||= crypto.randomUUID();
    browserInstanceId ||= crypto.randomUUID();
  }
  await loadStoredConsent();
  if (!authorityTimer) authorityTimer = setInterval(authorityTick, AUTHORITY_TICK_MS);
  connectNative();
}

async function recordNativeDiagnostic(patch) {
  try {
    const current = await browser.storage.local.get("zameryBrowserFirefoxNativeDiagnostic");
    await browser.storage.local.set({
      zameryBrowserFirefoxNativeDiagnostic: {
        ...(current.zameryBrowserFirefoxNativeDiagnostic || {}),
        ...patch,
        updated_at: Date.now(),
      },
    });
  } catch {}
}

function connectNative() {
  const attempt = ++nativeConnectAttempt;
  void recordNativeDiagnostic({ state: "connecting", attempt });
  try {
    nativePort = browser.runtime.connectNative(HOST_NAME);
  } catch (error) {
    console.error("[zamery-browser-firefox] connectNative failed", error);
    void recordNativeDiagnostic({ state: "connect_throw", attempt, error: String(error?.message || error) });
    setTimeout(connectNative, 1000);
    return;
  }
  void recordNativeDiagnostic({ state: "port_created", attempt });
  nativePort.onMessage.addListener((message) => {
    void recordNativeDiagnostic({ state: "message_received", attempt, message_type: String(message?.type || "unknown") });
    void onNativeMessage(message);
  });
  nativePort.onDisconnect.addListener((port) => {
    const error = port?.error?.message || browser.runtime.lastError?.message || null;
    void recordNativeDiagnostic({ state: "disconnected", attempt, error });
    void teardownAssetV1Transfers("native_disconnect");
    nativePort = undefined;
    currentHostSessionId = null;
    currentHostProtocolVersion = null;
    // The bridge died: whatever was bound to that host session is no longer live.
    if (binding) dropBinding("native_disconnect");
    setTimeout(connectNative, 1000);
  });
  announceIdentity();
  void emitHeartbeat();
  if (!heartbeatTimer) heartbeatTimer = setInterval(() => void emitHeartbeat(), 5000);
}

function announceIdentity() {
  if (!nativePort || !profileId || !browserInstanceId) return;
  postNative({
    type: "hello",
    protocol_version: PROTOCOL_VERSION,
    extension_id: browser.runtime.id,
    extension_version: browser.runtime.getManifest().version,
    profile_id: profileId,
    browser_instance_id: browserInstanceId,
  });
}

function postNative(message) {
  try {
    nativePort?.postMessage(message);
  } catch (error) {
    console.error("[zamery-browser-firefox] native write failed", error);
  }
}

async function emitHeartbeat() {
  const active = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = active[0];
  // Never advertise which tab is active unless that tab is shared with the connected consumer.
  const shared = typeof tab?.id === "number" && binding?.scope?.tabs?.[String(tab.id)];
  postNative({
    type: "heartbeat",
    browser_instance_id: browserInstanceId,
    profile_id: profileId,
    active_context_id: shared ? contextIdFor(tab.id) : null,
    at: Date.now(),
  });
}

async function onNativeMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "host_status") {
    const nextSessionId = typeof message.host_session_id === "string" ? message.host_session_id : null;
    currentHostProtocolVersion = Number(message.protocol_version);
    if (nextSessionId) currentHostSessionId = nextSessionId;
    ensureAuthorityCurrent();
    return;
  }
  if (message.type === "cancel" && typeof message.target_id === "string") {
    cancelledRequests.add(message.target_id);
    const assetV1Target = assetV1RequestContexts.get(message.target_id);
    if (assetV1Target) {
      void browser.tabs.sendMessage(
        assetV1Target.tab_id,
        { type: "zamery_browser_firefox_asset_cancel_request_v1", request_id: message.target_id },
        { frameId: 0 },
      ).catch(() => undefined);
    }
    const a1Target = a1RequestContexts.get(message.target_id);
    if (a1Target) {
      void browser.tabs.sendMessage(
        a1Target.tab_id,
        { type: "zamery_browser_firefox_a1_asset_cancel_request", request_id: message.target_id },
        { frameId: 0 },
      ).catch(() => undefined);
    }
    postNative({
      type: "cancel_ack",
      id: message.id || null,
      target_id: message.target_id,
      phase: requestPhases.get(message.target_id) || "unknown",
    });
    return;
  }
  if (message.type !== "request" || typeof message.id !== "string") return;
  await handleRequest(message);
}

// ---- request pipeline: authorize execution AND delivery ------------------------------------------

function respond(id, fields) {
  postNative({ type: "response", id, ...fields });
}

function denied(id, error, outcome = "not_started") {
  respond(id, { replayed: false, ok: false, error: normalizeError(error), outcome });
}

/** What may leave the companion after authority changed mid-flight: only a safe mutation status. */
function deliverableAfterAuthorityLoss(op, response) {
  if (MUTATION_OPS.has(op) && response?.ok) {
    return { ok: true, outcome: "completed", result: { outcome: "completed" }, authority_ended: true };
  }
  if (MUTATION_OPS.has(op)) return response;
  return null;
}

async function handleRequest(message) {
  const id = message.id;
  const op = String(message.op || "");
  const audienceId = requestAudienceId(message);

  if (op === "status") {
    // Diagnostics (`probe`) must not show up as a local agent the user could share tabs with.
    if (message.params?.probe !== true) recordAudience(audienceId, message.params?.client_label);
    respond(id, { replayed: false, ok: true, result: { ...statusResult(audienceId), browser_info: await browserInfo() } });
    return;
  }

  let lineage;
  try {
    lineage = authorizeRequest(message);
  } catch (error) {
    denied(id, error);
    return;
  }
  const fingerprint = mutationFingerprint(message);
  const key = `${audienceId}\u0000${id}`;

  if (inFlightRequests.has(key)) {
    const inFlight = inFlightRequests.get(key);
    if (inFlight.fingerprint !== fingerprint) {
      respond(id, { replayed: true, ok: false, error: { code: "REQUEST_ID_CONFLICT", message: "request id was reused with different parameters" }, outcome: "not_started" });
      return;
    }
    const joined = await inFlight.promise;
    postDelivery(message, op, lineage, joined, true);
    return;
  }

  if (MUTATION_OPS.has(op) && completedRequests.has(key)) {
    const completed = completedRequests.get(key);
    if (completed.fingerprint !== fingerprint) {
      respond(id, { replayed: true, ok: false, error: { code: "REQUEST_ID_CONFLICT", message: "request id was reused with different parameters" }, outcome: "not_started" });
      return;
    }
    // Replays are authorized like fresh requests: the grant lineage must still be the one that produced them.
    if (lineageCurrent(completed.lineage)) {
      respond(id, { replayed: true, ...completed.response });
    } else {
      denied(id, denial("BROWSER_AUTHORIZATION_REQUIRED", "grant_changed_since_original_request"));
    }
    return;
  }

  const execution = executeRequest(message)
    .then((result) => ({ ok: true, result }))
    .catch((error) => ({
      ok: false,
      error: normalizeError(error),
      outcome: error?.outcome || "not_started",
    }));
  inFlightRequests.set(key, { fingerprint, promise: execution });
  const response = await execution;
  inFlightRequests.delete(key);
  postDelivery(message, op, lineage, response, false);
}

function postDelivery(message, op, lineage, response, joined) {
  const id = message.id;
  if (!lineageCurrent(lineage)) {
    // Authority changed while the request ran. Page-bearing results never leave; mutations report a safe status.
    const safe = deliverableAfterAuthorityLoss(op, response);
    if (safe) respond(id, { replayed: joined, ...safe });
    else denied(id, denial("BROWSER_AUTHORIZATION_REQUIRED", "authorization_changed_during_request"));
    return;
  }
  // A request that never started is not a recorded outcome: retrying the same id must run for real.
  const neverStarted = response?.ok !== true && (response?.outcome === undefined || response?.outcome === "not_started");
  if (MUTATION_OPS.has(op) && !neverStarted) rememberCompleted(`${lineage.audienceId}\u0000${id}`, mutationFingerprint(message), response, lineage);
  respond(id, { replayed: joined, ...response });
}

function rememberCompleted(key, fingerprint, response, lineage) {
  completedRequests.set(key, { fingerprint, response, lineage });
  while (completedRequests.size > MAX_COMPLETED_REQUESTS) {
    completedRequests.delete(completedRequests.keys().next().value);
  }
}

function normalizeError(error) {
  return {
    code: error?.code || "BROWSER_REQUEST_FAILED",
    message: String(error?.message || error || "browser request failed").slice(0, 300),
    reason: error?.reason,
  };
}

let cachedBrowserInfo;
async function browserInfo() {
  if (cachedBrowserInfo) return cachedBrowserInfo;
  try {
    const info = await browser.runtime.getBrowserInfo?.();
    cachedBrowserInfo = info ? { name: String(info.name || ""), version: String(info.version || ""), build_id: String(info.buildID || "") } : { name: "", version: "", build_id: "" };
  } catch {
    cachedBrowserInfo = { name: "", version: "", build_id: "" };
  }
  return cachedBrowserInfo;
}

function statusResult(audienceId) {
  return {
    protocol_version: PROTOCOL_VERSION,
    browser_family: "firefox",
    browser_instance_id: browserInstanceId,
    profile_id: profileId,
    startup_direction: "webextension-connectNative",
    managed_browser: false,
    companion_extension_id: browser.runtime.id,
    companion_extension_version: browser.runtime.getManifest().version,
    browser_run_epoch: browserRunEpoch,
    features: featureSummary(),
    authorization: authorizationStatus({ detail: "consumer", audienceId }),
  };
}

function featureSummary() {
  return {
    tab_groups_api: typeof groupsApiAvailable === "function" ? groupsApiAvailable() : false,
    capture_tab_api: typeof browser.tabs.captureTab === "function",
    screenshots: typeof browser.tabs.captureTab === "function",
    control: true,
    tabs: true,
  };
}

async function executeRequest(message) {
  const op = String(message.op || "");
  const params = message.params && typeof message.params === "object" ? message.params : {};
  const audienceId = requestAudienceId(message);

  if (op === "list_contexts") return listContexts();
  if (op === "snapshot") return snapshotContext(params, audienceId);
  if (op === "act") return actOnContext(params, message.id, message);
  if (op === "control_claim") return controlClaim(params, audienceId);
  if (op === "control_release") return controlRelease(audienceId);
  if (op === "control_takeover") return controlAgentTakeover(params);
  if (op === "control_request_resume") return controlRequestResume();
  if (op === "create_tab") return createOwnedTab(params);
  if (op === "close_owned_tab") return closeOwnedTab(params);
  if (typeof executeExtendedRequest === "function") {
    const handled = await executeExtendedRequest(op, params, message);
    if (handled !== undefined) return handled.value;
  }
  if (typeof executeArtifactRequest === "function") {
    const handled = await executeArtifactRequest(op, params, message);
    if (handled !== undefined) return handled.value;
  }
  if (op === "asset_capabilities_v1") return assetCapabilitiesV1(params);
  if (op === "asset_discover_v1") return assetDiscoverV1(params);
  if (op === "asset_open_v1") return assetOpenV1(params, message.id);
  if (op === "asset_read_chunk_v1") return assetReadChunkV1(params, message.id);
  if (op === "asset_close_v1") return assetCloseV1(params, message.id);
  if (op === "a1_asset_discover") return a1AssetDiscover(params, message.id);
  if (op === "a1_asset_open") return a1AssetOpen(params, message.id);
  if (op === "a1_asset_read_chunk") return a1AssetReadChunk(params, message.id);
  if (op === "a1_asset_close") return a1AssetClose(params, message.id);

  throw newError("UNSUPPORTED_OPERATION", `unsupported operation: ${op}`);
}

function contextIdFor(tabId) {
  return `tab:${tabId}`;
}

function tabIdFromContext(contextId) {
  const match = /^tab:(\d+)$/.exec(String(contextId || ""));
  if (!match) {
    const error = new Error("invalid context id");
    error.code = "INVALID_CONTEXT";
    throw error;
  }
  return Number(match[1]);
}

function classifyUrl(url) {
  const value = String(url || "");
  if (/^(about|moz-extension|view-source):/i.test(value)) {
    return { inspect: false, act: false, screenshot: "probe", reason: "privileged_or_extension_surface" };
  }
  if (/^file:/i.test(value)) {
    return { inspect: false, act: false, screenshot: "probe", reason: "file_permission_not_declared" };
  }
  if (/^https?:/i.test(value)) {
    return { inspect: "probe", act: "probe", screenshot: "probe" };
  }
  return { inspect: false, act: false, screenshot: "probe", reason: "unsupported_scheme" };
}

function primaryDocumentTarget(browserDocumentId) {
  const value = typeof browserDocumentId === "string" ? browserDocumentId : "";
  return value ? { documentId: value } : PRIMARY_DOCUMENT_TARGET;
}

async function armAllFrames(tabId) {
  // No frameId: delivered to every frame of the tab so human input inside iframes is also observed.
  await browser.tabs.sendMessage(tabId, { type: "zamery_browser_firefox_arm" }).catch(() => undefined);
}

async function ensureContent(tabId, options = {}) {
  const ping = { type: "zamery_browser_firefox_ping", ...(options.arm ? { arm: true } : {}) };
  let response;
  try {
    response = await browser.tabs.sendMessage(tabId, ping, PRIMARY_DOCUMENT_TARGET);
  } catch (firstError) {
    try {
      await browser.tabs.executeScript(tabId, { file: "content.js", allFrames: false, runAt: "document_idle" });
      response = await browser.tabs.sendMessage(tabId, ping, PRIMARY_DOCUMENT_TARGET);
    } catch (error) {
      const wrapped = new Error(`content unavailable: ${error?.message || firstError?.message || error}`);
      wrapped.code = "CONTEXT_UNAVAILABLE";
      wrapped.reason = "content_script_injection_blocked";
      throw wrapped;
    }
  }
  if (options.arm) await armAllFrames(tabId);
  return response;
}

async function ensureAssetDiscoveryContent(tabId) {
  try {
    const ping = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
    if (ping?.asset_discovery_v1_ready) return ping;
  } catch {}
  try {
    await browser.tabs.executeScript(tabId, {
      file: "asset-discovery-v1.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    await browser.tabs.executeScript(tabId, {
      file: "asset-transfer-v1.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    await browser.tabs.executeScript(tabId, {
      file: "content.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    const ping = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
    if (ping?.asset_discovery_v1_ready) return ping;
    throw new Error("asset discovery helper did not initialize");
  } catch (error) {
    const wrapped = new Error("browser asset discovery content is unavailable");
    wrapped.code = "BROWSER_CONTEXT_GONE";
    wrapped.reason = "asset_discovery_content_unavailable";
    throw wrapped;
  }
}

async function assetDiscoveryContentCall(tabId, message) {
  let timer;
  try {
    const response = await Promise.race([
      browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("browser asset discovery content RPC timed out");
          error.code = "BROWSER_ASSET_TIMEOUT";
          error.reason = "content_rpc_timeout";
          reject(error);
        }, ASSET_DISCOVERY_CONTENT_RPC_TIMEOUT_MS);
      }),
    ]);
    if (!response?.ok) {
      const error = new Error(String(response?.error?.message || "browser asset discovery failed"));
      error.code = response?.error?.code || "BROWSER_ASSET_FETCH_FAILED";
      error.reason = response?.error?.reason;
      throw error;
    }
    return response.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanupAssetV1Registry() {
  const current = Date.now();
  for (const [ref, entry] of assetV1Refs) {
    if (entry.expires_at <= current) assetV1Refs.delete(ref);
  }
}

async function assetDiscoverV1(params) {
  cleanupAssetV1Registry();
  const contextId = String(params.context_id || "");
  const { tabId } = await contextAuthorization(contextId, "inspect");
  const ping = await ensureAssetDiscoveryContent(tabId);
  const discovered = await assetDiscoveryContentCall(tabId, {
    type: "zamery_browser_firefox_asset_discover_v1",
  });
  if (discovered?.document_id !== ping.document_id) {
    const error = new Error("asset discovery document identity changed during discovery");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "document_identity_mismatch";
    throw error;
  }
  const requestedLimit = Number(params.limit);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(100, requestedLimit)
    : 100;
  const snapshotId = crypto.randomUUID();
  const sourceAssets = Array.isArray(discovered?.assets) ? discovered.assets.slice(0, limit) : [];
  const assets = sourceAssets.map((asset) => {
    const publicRef = `basset_v1_${crypto.randomUUID()}`;
    assetV1Refs.set(publicRef, {
      browser_instance_id: browserInstanceId,
      context_id: contextId,
      tab_id: tabId,
      document_id: ping.document_id,
      content_asset_ref: asset.asset_ref,
      expires_at: Number(asset.expires_at) || Date.now() + ASSET_V1_REGISTRY_TTL_MS,
    });
    while (assetV1Refs.size > ASSET_V1_MAX_REFS) assetV1Refs.delete(assetV1Refs.keys().next().value);
    const elementRef = asset.element_node_id ? encodeRef({
      b: browserInstanceId,
      c: contextId,
      d: ping.document_id,
      f: 0,
      s: snapshotId,
      n: asset.element_node_id,
    }) : undefined;
    const containerRef = asset.container_node_id ? encodeRef({
      b: browserInstanceId,
      c: contextId,
      d: ping.document_id,
      f: 0,
      s: snapshotId,
      n: asset.container_node_id,
    }) : undefined;
    return {
      asset_ref: publicRef,
      media_kind: asset.media_kind,
      safe_label: asset.safe_label,
      document_order: asset.document_order,
      rendered: asset.rendered === true,
      intrinsic_width: asset.intrinsic_width,
      intrinsic_height: asset.intrinsic_height,
      representation: { role: asset?.representation?.role || "unknown" },
      discovered_at: asset.discovered_at,
      expires_at: asset.expires_at,
      ...(elementRef ? { element_ref: elementRef } : {}),
      ...(containerRef ? { container_ref: containerRef } : {}),
    };
  });
  return {
    schema: "zamery-browser-assets-v1/1",
    browser_instance_id: browserInstanceId,
    context_id: contextId,
    document_id: ping.document_id,
    frame_identity: "top",
    snapshot_id: snapshotId,
    assets,
  };
}

async function assetCapabilitiesV1(params) {
  const contextId = String(params.context_id || "");
  const { tabId } = await contextAuthorization(contextId, "inspect");
  try {
    const ping = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
    return {
      discover: ping?.asset_discovery_v1_ready
        ? { state: "ready" }
        : { state: "unavailable", reason: "asset_discovery_helper_requires_reload" },
      read: ping?.asset_transfer_v1_ready
        ? { state: "ready" }
        : { state: "unavailable", reason: "asset_transfer_helper_requires_reload" },
    };
  } catch {
    return {
      discover: { state: "unavailable", reason: "content_unavailable" },
      read: { state: "unavailable", reason: "content_unavailable" },
    };
  }
}

async function ensureAssetTransferContent(tabId) {
  let ping;
  try {
    ping = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
  } catch {
    ping = null;
  }
  if (ping?.asset_transfer_v1_ready) return ping;
  if (ping) {
    const error = new Error("browser asset transfer helper is not loaded in the current document");
    error.code = "BROWSER_ASSET_FETCH_FAILED";
    error.reason = "asset_transfer_helper_requires_reload";
    throw error;
  }
  try {
    await browser.tabs.executeScript(tabId, {
      file: "asset-discovery-v1.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    await browser.tabs.executeScript(tabId, {
      file: "asset-transfer-v1.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    await browser.tabs.executeScript(tabId, {
      file: "content.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    const nextPing = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
    if (nextPing?.asset_transfer_v1_ready) return nextPing;
    throw new Error("asset transfer helper did not initialize");
  } catch (error) {
    const wrapped = new Error("browser asset transfer content is unavailable");
    wrapped.code = "BROWSER_ASSET_FETCH_FAILED";
    wrapped.reason = "asset_transfer_content_unavailable";
    throw wrapped;
  }
}

async function assetTransferContentCall(tabId, message) {
  let timer;
  try {
    const response = await Promise.race([
      browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("browser asset transfer content RPC timed out");
          error.code = "BROWSER_ASSET_TIMEOUT";
          error.reason = "content_rpc_timeout";
          reject(error);
        }, ASSET_TRANSFER_CONTENT_RPC_TIMEOUT_MS);
      }),
    ]);
    if (!response?.ok) {
      const error = new Error(String(response?.error?.message || "browser asset transfer failed"));
      error.code = response?.error?.code || "BROWSER_ASSET_FETCH_FAILED";
      error.reason = response?.error?.reason;
      throw error;
    }
    return response.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanupAssetV1Registries() {
  const current = Date.now();
  for (const [ref, entry] of assetV1Refs) {
    if (entry.expires_at <= current) assetV1Refs.delete(ref);
  }
  for (const [handle, transfer] of assetV1Transfers) {
    if (transfer.expires_at > current) continue;
    assetV1Transfers.delete(handle);
    void browser.tabs.sendMessage(
      transfer.tab_id,
      { type: "zamery_browser_firefox_asset_close_v1", asset_handle: transfer.content_asset_handle, reason: "timeout" },
      { frameId: 0 },
    ).catch(() => undefined);
  }
}

async function withAssetV1Request(requestId, tabId, run) {
  if (cancelledRequests.has(requestId)) {
    cancelledRequests.delete(requestId);
    const error = new Error("browser asset request cancelled before execution");
    error.code = "BROWSER_ASSET_ABORTED";
    error.reason = "cancelled_before_start";
    throw error;
  }
  requestPhases.set(requestId, "started");
  assetV1RequestContexts.set(requestId, { tab_id: tabId });
  try {
    return await run();
  } finally {
    assetV1RequestContexts.delete(requestId);
    requestPhases.delete(requestId);
    cancelledRequests.delete(requestId);
  }
}

async function assetOpenV1(params, requestId) {
  cleanupAssetV1Registries();
  const publicRef = String(params.asset_ref || "");
  const asset = assetV1Refs.get(publicRef);
  if (!asset) {
    const error = new Error("browser asset ref is unknown or expired");
    error.code = "BROWSER_ASSET_REF_UNKNOWN";
    error.reason = "unknown_or_expired";
    throw error;
  }
  const requestedContextId = String(params.context_id || "");
  if (asset.browser_instance_id !== browserInstanceId || (requestedContextId && requestedContextId !== asset.context_id)) {
    const error = new Error("browser asset binding changed");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "browser_or_context_changed";
    throw error;
  }
  await contextAuthorization(asset.context_id, "inspect");
  const ping = await ensureAssetTransferContent(asset.tab_id);
  if (ping?.document_id !== asset.document_id) {
    const error = new Error("browser document changed");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "document_changed";
    throw error;
  }
  if (assetV1Transfers.size >= ASSET_V1_MAX_ACTIVE_TRANSFERS) {
    const error = new Error("browser asset transfer limit reached");
    error.code = "BROWSER_ASSET_TRANSFER_PROTOCOL";
    error.reason = "active_transfer_limit_reached";
    throw error;
  }
  return withAssetV1Request(requestId, asset.tab_id, async () => {
    const opened = await assetTransferContentCall(asset.tab_id, {
      type: "zamery_browser_firefox_asset_open_v1",
      asset_ref: asset.content_asset_ref,
      expected_document_id: asset.document_id,
      max_asset_bytes: params.max_bytes,
      request_id: requestId,
    });
    const publicHandle = `bhandle_v1_${crypto.randomUUID()}`;
    const publicTransferId = `btransfer_v1_${crypto.randomUUID()}`;
    assetV1Transfers.set(publicHandle, {
      browser_instance_id: browserInstanceId,
      context_id: asset.context_id,
      tab_id: asset.tab_id,
      document_id: asset.document_id,
      content_asset_handle: opened.asset_handle,
      content_transfer_id: opened.transfer_id,
      public_transfer_id: publicTransferId,
      expires_at: Date.now() + ASSET_V1_TRANSFER_TTL_MS,
    });
    const { asset_handle: _internalHandle, transfer_id: _internalTransferId, ...safe } = opened;
    return { ...safe, asset_handle: publicHandle, transfer_id: publicTransferId };
  });
}

async function assetReadChunkV1(params, requestId) {
  cleanupAssetV1Registries();
  const publicHandle = String(params.asset_handle || "");
  const transfer = assetV1Transfers.get(publicHandle);
  if (!transfer) {
    const error = new Error("browser asset handle is unknown or expired");
    error.code = "BROWSER_ASSET_TRANSFER_PROTOCOL";
    error.reason = "asset_handle_unknown_or_expired";
    throw error;
  }
  await contextAuthorization(transfer.context_id, "inspect");
  const ping = await ensureAssetTransferContent(transfer.tab_id);
  if (ping?.document_id !== transfer.document_id) {
    assetV1Transfers.delete(publicHandle);
    const error = new Error("browser document changed during asset transfer");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "document_changed";
    throw error;
  }
  return withAssetV1Request(requestId, transfer.tab_id, async () => {
    const chunk = await assetTransferContentCall(transfer.tab_id, {
      type: "zamery_browser_firefox_asset_read_chunk_v1",
      asset_handle: transfer.content_asset_handle,
      sequence: params.sequence,
      offset: params.offset,
      max_raw_bytes: params.max_raw_bytes,
      request_id: requestId,
    });
    if (chunk.transfer_id !== transfer.content_transfer_id) {
      assetV1Transfers.delete(publicHandle);
      const error = new Error("browser asset transfer identity changed");
      error.code = "BROWSER_ASSET_TRANSFER_PROTOCOL";
      error.reason = "content_transfer_id_changed";
      throw error;
    }
    transfer.expires_at = Date.now() + ASSET_V1_TRANSFER_TTL_MS;
    return { ...chunk, transfer_id: transfer.public_transfer_id };
  });
}

async function assetCloseV1(params, requestId) {
  cleanupAssetV1Registries();
  const publicHandle = String(params.asset_handle || "");
  const transfer = assetV1Transfers.get(publicHandle);
  if (!transfer) return { closed: true };
  await contextAuthorization(transfer.context_id, "inspect");
  assetV1Transfers.delete(publicHandle);
  return withAssetV1Request(requestId, transfer.tab_id, async () => {
    await assetTransferContentCall(transfer.tab_id, {
      type: "zamery_browser_firefox_asset_close_v1",
      asset_handle: transfer.content_asset_handle,
      reason: params.reason,
      request_id: requestId,
    });
    return { closed: true };
  });
}

async function teardownAssetV1Transfers(reason = "teardown") {
  const tabIds = new Set();
  for (const transfer of assetV1Transfers.values()) tabIds.add(transfer.tab_id);
  assetV1Transfers.clear();
  assetV1RequestContexts.clear();
  await Promise.all(Array.from(tabIds, (tabId) => browser.tabs.sendMessage(
    tabId,
    { type: "zamery_browser_firefox_asset_teardown_v1", reason },
    { frameId: 0 },
  ).catch(() => undefined)));
}

function requireA1DevelopmentCompanion() {
  if (browser.runtime.id === A1_DEVELOPMENT_EXTENSION_ID) return;
  const error = new Error("A1 browser asset experiment is development-companion only");
  error.code = "BROWSER_ASSET_EXPERIMENT_UNAVAILABLE";
  error.reason = "production_companion_does_not_advertise_a1_asset_probe";
  throw error;
}

async function ensureA1Content(tabId) {
  requireA1DevelopmentCompanion();
  try {
    const ping = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
    if (ping?.a1_asset_experiment_ready) return ping;
    const error = new Error("A1 asset helper is not loaded in the current document");
    error.code = "BROWSER_ASSET_EXPERIMENT_UNAVAILABLE";
    error.reason = "development_companion_or_document_requires_reload";
    throw error;
  } catch (firstError) {
    if (firstError?.code === "BROWSER_ASSET_EXPERIMENT_UNAVAILABLE") throw firstError;
    try {
      await browser.tabs.executeScript(tabId, {
        file: "asset-a1-experimental.js",
        frameId: 0,
        allFrames: false,
        runAt: "document_idle",
      });
      await browser.tabs.executeScript(tabId, {
        file: "content.js",
        frameId: 0,
        allFrames: false,
        runAt: "document_idle",
      });
      const ping = await browser.tabs.sendMessage(
        tabId,
        { type: "zamery_browser_firefox_ping" },
        { frameId: 0 },
      );
      if (ping?.a1_asset_experiment_ready) return ping;
      throw new Error("A1 asset helper did not initialize");
    } catch (error) {
      const wrapped = new Error("A1 browser asset content probe is unavailable");
      wrapped.code = "BROWSER_ASSET_EXPERIMENT_UNAVAILABLE";
      wrapped.reason = "content_script_injection_blocked_or_helper_unavailable";
      throw wrapped;
    }
  }
}

function cleanupA1Registries() {
  const current = Date.now();
  for (const [ref, entry] of a1AssetRefs) {
    if (entry.expires_at <= current) a1AssetRefs.delete(ref);
  }
  for (const [handle, entry] of a1Transfers) {
    if (entry.expires_at <= current) a1Transfers.delete(handle);
  }
}

function a1ContentError(response) {
  const error = new Error(String(response?.error?.message || "A1 browser asset operation failed"));
  error.code = response?.error?.code || "BROWSER_ASSET_FETCH_FAILED";
  error.reason = response?.error?.reason;
  return error;
}

async function a1ContentCall(tabId, message) {
  let timer;
  try {
    const response = await Promise.race([
      browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("A1 browser asset content RPC timed out");
          error.code = "BROWSER_ASSET_TIMEOUT";
          error.reason = "content_rpc_timeout";
          reject(error);
        }, A1_CONTENT_RPC_TIMEOUT_MS);
      }),
    ]);
    if (!response?.ok) throw a1ContentError(response);
    return response.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withA1Request(requestId, tabId, run) {
  if (cancelledRequests.has(requestId)) {
    cancelledRequests.delete(requestId);
    const error = new Error("browser asset request cancelled before execution");
    error.code = "BROWSER_REQUEST_CANCELLED";
    error.outcome = "not_started";
    throw error;
  }
  requestPhases.set(requestId, "started");
  a1RequestContexts.set(requestId, { tab_id: tabId });
  try {
    return await run();
  } finally {
    a1RequestContexts.delete(requestId);
    requestPhases.delete(requestId);
    cancelledRequests.delete(requestId);
  }
}

async function a1AssetDiscover(params, requestId) {
  cleanupA1Registries();
  const contextId = String(params.context_id || "");
  const { tabId } = await contextAuthorization(contextId, "inspect");
  const ping = await ensureA1Content(tabId);
  return withA1Request(requestId, tabId, async () => {
    const discovered = await a1ContentCall(tabId, {
      type: "zamery_browser_firefox_a1_asset_discover",
      request_id: requestId,
    });
    if (discovered?.document_id !== ping.document_id) {
      const error = new Error("asset discovery document identity does not match the top-frame ping");
      error.code = "BROWSER_ASSET_STALE";
      error.reason = "document_identity_mismatch";
      throw error;
    }
    const assets = Array.isArray(discovered?.assets) ? discovered.assets.map((asset) => {
      const publicRef = `basset_a1_${crypto.randomUUID()}`;
      a1AssetRefs.set(publicRef, {
        browser_instance_id: browserInstanceId,
        context_id: contextId,
        tab_id: tabId,
        document_id: ping.document_id,
        content_asset_ref: asset.asset_ref,
        expires_at: Date.now() + A1_REGISTRY_TTL_MS,
      });
      while (a1AssetRefs.size > A1_MAX_ASSET_REFS) a1AssetRefs.delete(a1AssetRefs.keys().next().value);
      const { asset_ref: _internalRef, ...safe } = asset;
      return { ...safe, asset_ref: publicRef };
    }) : [];
    return {
      schema: "zamery-browser-assets-a1-experimental/1",
      browser_instance_id: browserInstanceId,
      context_id: contextId,
      document_id: ping.document_id,
      frame_identity: "top",
      assets,
    };
  });
}

async function a1AssetOpen(params, requestId) {
  cleanupA1Registries();
  const publicRef = String(params.asset_ref || "");
  const asset = a1AssetRefs.get(publicRef);
  if (!asset) {
    const error = new Error("browser asset ref is unknown or expired");
    error.code = "ASSET_REF_UNKNOWN";
    throw error;
  }
  if (asset.browser_instance_id !== browserInstanceId) {
    const error = new Error("browser instance changed");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "browser_instance_changed";
    throw error;
  }
  await contextAuthorization(asset.context_id, "inspect");
  const ping = await ensureA1Content(asset.tab_id);
  if (ping?.document_id !== asset.document_id) {
    const error = new Error("browser document changed");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "document_changed";
    throw error;
  }
  if (a1Transfers.size >= A1_MAX_ACTIVE_TRANSFERS) {
    const error = new Error("A1 browser asset transfer limit reached");
    error.code = "BROWSER_ASSET_TRANSFER_LIMIT";
    error.reason = "active_transfer_limit_reached";
    throw error;
  }
  return withA1Request(requestId, asset.tab_id, async () => {
    const opened = await a1ContentCall(asset.tab_id, {
      type: "zamery_browser_firefox_a1_asset_open",
      asset_ref: asset.content_asset_ref,
      expected_document_id: asset.document_id,
      max_asset_bytes: params.max_asset_bytes,
      request_id: requestId,
    });
    const publicHandle = `bhandle_a1_${crypto.randomUUID()}`;
    const publicTransferId = `btransfer_a1_${crypto.randomUUID()}`;
    a1Transfers.set(publicHandle, {
      browser_instance_id: browserInstanceId,
      context_id: asset.context_id,
      tab_id: asset.tab_id,
      document_id: asset.document_id,
      content_asset_handle: opened.asset_handle,
      content_transfer_id: opened.transfer_id,
      public_transfer_id: publicTransferId,
      expires_at: Date.now() + A1_REGISTRY_TTL_MS,
    });
    const { asset_handle: _internalHandle, transfer_id: _internalTransferId, ...safe } = opened;
    return {
      ...safe,
      asset_handle: publicHandle,
      transfer_id: publicTransferId,
      frame_identity: "top",
    };
  });
}

async function a1AssetReadChunk(params, requestId) {
  cleanupA1Registries();
  const publicHandle = String(params.asset_handle || "");
  const transfer = a1Transfers.get(publicHandle);
  if (!transfer) {
    const error = new Error("asset handle is unknown or expired");
    error.code = "ASSET_HANDLE_UNKNOWN";
    throw error;
  }
  await contextAuthorization(transfer.context_id, "inspect");
  const ping = await ensureA1Content(transfer.tab_id);
  if (ping?.document_id !== transfer.document_id) {
    a1Transfers.delete(publicHandle);
    const error = new Error("browser document changed during asset transfer");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "document_changed";
    throw error;
  }
  return withA1Request(requestId, transfer.tab_id, async () => {
    const chunk = await a1ContentCall(transfer.tab_id, {
      type: "zamery_browser_firefox_a1_asset_read_chunk",
      asset_handle: transfer.content_asset_handle,
      sequence: params.sequence,
      offset: params.offset,
      max_raw_bytes: params.max_raw_bytes,
      request_id: requestId,
    });
    if (chunk.transfer_id !== transfer.content_transfer_id) {
      a1Transfers.delete(publicHandle);
      const error = new Error("asset transfer identity changed");
      error.code = "ASSET_IMPORT_TRANSFER_PROTOCOL";
      error.reason = "content_transfer_id_changed";
      throw error;
    }
    transfer.expires_at = Date.now() + A1_REGISTRY_TTL_MS;
    return { ...chunk, transfer_id: transfer.public_transfer_id };
  });
}

async function a1AssetClose(params, requestId) {
  cleanupA1Registries();
  const publicHandle = String(params.asset_handle || "");
  const transfer = a1Transfers.get(publicHandle);
  if (!transfer) return { closed: false, reason: "not_found" };
  await contextAuthorization(transfer.context_id, "inspect");
  a1Transfers.delete(publicHandle);
  return withA1Request(requestId, transfer.tab_id, async () => a1ContentCall(transfer.tab_id, {
    type: "zamery_browser_firefox_a1_asset_close",
    asset_handle: transfer.content_asset_handle,
    request_id: requestId,
  }));
}

// ---- contexts, refs, snapshots ---------------------------------------------------------------------

function urlHash(url) {
  let hash = 0x811c9dc5;
  const text = String(url || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

async function listContexts() {
  const candidates = (await Promise.all(
    [...authorizedTabIds()].map((tabId) => browser.tabs.get(tabId).catch(() => null)),
  )).filter(Boolean);
  const contexts = [];
  for (const tab of candidates) {
    if (typeof tab.id !== "number") continue;
    const verdict = Policy.evaluateTabAccess({ scope: binding.scope, actions: binding.actions, pendingOrigins: pendingOriginChanges }, tab, "inspect");
    const entry = binding.scope.tabs[String(tab.id)];
    const base = {
      context_id: contextIdFor(tab.id),
      tab_id: tab.id,
      window_id: tab.windowId,
      active: Boolean(tab.active),
      ownership: ownedTabIds.has(tab.id) ? "provider-owned" : "user-owned",
      partition: entry?.partition ?? null,
      claimed: control.state === "agent_claimed" && control.claimedContextId === contextIdFor(tab.id),
    };
    if (!verdict.ok) {
      // Withdrawn tabs are reported without title/url so a changed site never leaks before the user confirms it.
      if (verdict.reason === "private_window_denied" || verdict.reason === "outside_scope") continue;
      contexts.push({ ...base, title: "", url: "", availability: { inspect: false, act: false, screenshot: false, reason: verdict.reason } });
      continue;
    }
    const availability = classifyUrl(tab.url);
    if (availability.inspect === "probe") {
      try {
        const ping = await ensureContent(tab.id);
        availability.inspect = true;
        availability.act = binding.actions.includes("interact");
        availability.screenshot = binding.actions.includes("capture") && typeof browser.tabs.captureTab === "function";
        availability.document_id = ping?.document_id;
        availability.browser_document_id = ping?.browser_document_id || null;
        availability.document_identity = ping?.browser_document_id ? "browser-native" : "content-epoch";
        availability.navigator_webdriver = ping?.navigator_webdriver;
      } catch (error) {
        availability.inspect = false;
        availability.act = false;
        availability.reason = error?.reason || "content_unavailable";
      }
    }
    contexts.push({ ...base, title: tab.title, url: tab.url, availability });
  }
  return { browser_instance_id: browserInstanceId, contexts };
}

function encodeRef(payload) {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `r1.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

function decodeRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith("r1.")) throwRef("invalid_ref_encoding");
  const raw = ref.slice(3).replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - raw.length % 4) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throwRef("invalid_ref_payload");
  }
}

function throwRef(reason) {
  throw newError("STALE_ELEMENT_REF", reason, reason);
}

function tryClaim(contextId, audienceId) {
  if (!binding?.actions.includes("interact")) return { claimed: false, reason: "interact_not_granted" };
  const result = applyControl({
    type: "claim",
    contextId,
    audienceId,
    leaseId: crypto.randomUUID(),
  });
  if (!result.ok) return { claimed: false, reason: result.reason };
  return { claimed: true, reason: null };
}

async function snapshotContext(params, audienceId) {
  const contextId = String(params.context_id || "");
  const wantClaim = params.claim === true;
  const { tabId } = await contextAuthorization(contextId, "inspect");
  let claim = { claimed: false, reason: null };
  if (wantClaim) {
    await contextAuthorization(contextId, "interact").then(
      () => { claim = tryClaim(contextId, audienceId); },
      (error) => { claim = { claimed: false, reason: error?.reason || "interact_not_granted" }; },
    );
  }
  const armed = control.state === "agent_claimed" && control.claimedContextId === contextId;
  const ping = await ensureContent(tabId, { arm: armed });
  const snapshotTarget = primaryDocumentTarget(ping?.browser_document_id);
  const snapshot = await browser.tabs.sendMessage(
    tabId,
    { type: "zamery_browser_firefox_snapshot", arm: armed },
    snapshotTarget,
  );
  if (snapshot?.document_id !== ping?.document_id
    || (ping?.browser_document_id && snapshot?.browser_document_id !== ping.browser_document_id)) {
    throw newError("BROWSER_DOCUMENT_CHANGED", "primary document changed during snapshot", "document_changed_during_snapshot");
  }
  // The page may have navigated to another origin between authorization and export.
  await contextAuthorization(contextId, "inspect");
  const snapshotId = crypto.randomUUID();
  const claimGeneration = control.claimGeneration;
  const interactionGeneration = Number(snapshot?.interaction_generation) || 0;
  interactionGenerations.set(tabId, interactionGeneration);
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes.map((node) => ({
    ...node,
    ref: encodeRef({
      b: browserInstanceId,
      c: contextId,
      d: snapshot.document_id,
      bd: snapshot.browser_document_id || undefined,
      f: 0,
      s: snapshotId,
      n: node.node_id,
      g: binding.grantId,
      cg: claimGeneration,
      ig: interactionGeneration,
      u: urlHash(snapshot.url),
    }),
    node_id: undefined,
  })) : [];
  return {
    context_id: contextId,
    snapshot_id: snapshotId,
    document_id: snapshot?.document_id,
    browser_document_id: snapshot?.browser_document_id || null,
    document_identity: snapshot?.browser_document_id ? "browser-native" : "content-epoch",
    url: snapshot?.url,
    title: snapshot?.title,
    coverage: snapshot?.coverage || { truncated: false },
    text_blocks: Array.isArray(snapshot?.text_blocks) ? snapshot.text_blocks.slice(0, 120) : [],
    control: { ...controlSummary(audienceId), claimed_now: claim.claimed, claim_refused_reason: claim.claimed ? null : claim.reason },
    nodes,
  };
}

// ---- control: claim / takeover / resume -------------------------------------------------------------

let handoffNote = "";

async function controlClaim(params, audienceId) {
  const contextId = String(params.context_id || "");
  const { tabId } = await contextAuthorization(contextId, "interact");
  const result = applyControl({ type: "claim", contextId, audienceId, leaseId: crypto.randomUUID() });
  if (!result.ok) throw denial("BROWSER_AUTHORIZATION_REQUIRED", result.reason);
  handoffNote = "";
  await ensureContent(tabId, { arm: true }).catch(() => undefined);
  return { claimed: true, context_id: contextId, claim_generation: control.claimGeneration, lease_id: control.leaseId };
}

function controlRelease(audienceId) {
  if (control.state === "agent_claimed" && control.claimedAudienceId === audienceId) applyControl({ type: "release", reason: "released_by_agent" });
  return { state: control.state, claim_generation: control.claimGeneration };
}

function controlAgentTakeover(params) {
  const result = applyControl({ type: "takeover", reason: "agent_requested" });
  if (!result.ok) throw denial("BROWSER_AUTHORIZATION_REQUIRED", result.reason);
  handoffNote = String(params?.note || "").replace(/\s+/g, " ").trim().slice(0, 200);
  return { state: control.state, claim_generation: control.claimGeneration };
}

function controlRequestResume() {
  const result = applyControl({ type: "request_resume" });
  if (!result.ok) throw denial("BROWSER_AUTHORIZATION_REQUIRED", result.reason);
  return { state: control.state, resume_requested: control.resumeRequested };
}

function userTakeover(reason) {
  const before = control.state;
  const result = applyControl({ type: "takeover", reason });
  if (result.ok && before === "agent_claimed") handoffNote = "";
  return result;
}

// ---- mutations ---------------------------------------------------------------------------------

function queueMutation(contextId, fn) {
  const previous = mutationTails.get(contextId) || Promise.resolve();
  const execution = previous.catch(() => undefined).then(fn);
  const tail = execution
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (mutationTails.get(contextId) === tail) mutationTails.delete(contextId);
    });
  mutationTails.set(contextId, tail);
  return execution;
}

/** The claimed tab must be the active tab of Firefox's last-focused normal window at the moment of the write. */
async function requireFocusedTarget(tab) {
  const focused = await browser.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (!focused || focused.id !== tab.windowId || tab.active !== true) {
    throw denial("BROWSER_CONTEXT_UNAVAILABLE", "claimed_tab_not_focused", "the claimed tab is not the active tab of the focused Firefox window");
  }
}

async function actOnContext(params, requestId, message) {
  const contextId = String(params.context_id || "");
  const audienceId = requestAudienceId(message);
  const lineage = lineageNow(audienceId);
  requestPhases.set(requestId, "queued");
  return queueMutation(contextId, async () => {
    try {
      if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
        throw newError("BROWSER_REQUEST_CANCELLED", "browser mutation cancelled before execution", undefined, { outcome: "not_started" });
      }
      // Queued writes re-prove authority at the moment they would start.
      if (!lineageCurrent(lineage)) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "authorization_changed_while_queued");
      const { tabId, tab } = await contextAuthorization(contextId, "interact");
      const ref = decodeRef(params.ref);
      if (ref.b !== browserInstanceId) throwRef("browser_instance_changed");
      if (ref.c !== contextId) throwRef("context_changed");
      if (ref.f !== 0) throwRef("frame_changed");
      if (ref.g !== binding.grantId) throwRef("grant_changed");
      const claimVerdict = Policy.checkWriteClaim(control, { contextId, audienceId, claimGeneration: ref.cg });
      if (!claimVerdict.ok) throw denial(claimVerdict.code, claimVerdict.reason);
      await requireFocusedTarget(tab);

      const actionTarget = primaryDocumentTarget(ref.bd);
      let currentDocument;
      try {
        currentDocument = await browser.tabs.sendMessage(tabId, { type: "zamery_browser_firefox_ping", arm: true }, actionTarget);
      } catch {
        throwRef("document_changed");
      }
      if (currentDocument?.document_id !== ref.d
        || (ref.bd && currentDocument?.browser_document_id !== ref.bd)) {
        throwRef("document_changed");
      }
      if (urlHash(currentDocument?.url) !== ref.u) throwRef("page_navigated");
      if ((Number(currentDocument?.interaction_generation) || 0) !== ref.ig) {
        // A trusted human gesture touched the page since the observation: the user is driving now.
        userTakeover("human_interaction");
        throw newError("STALE_ELEMENT_REF", "the user interacted with the page since the observation", "user_interaction");
      }
      // Authority could have moved while we awaited the browser; check once more right before dispatch.
      if (!lineageCurrent(lineage)) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "authorization_changed_before_dispatch");
      const refreshed = Policy.checkWriteClaim(control, { contextId, audienceId, claimGeneration: ref.cg });
      if (!refreshed.ok) throw denial(refreshed.code, refreshed.reason);

      requestPhases.set(requestId, "started");
      lastAgentMutationAt = Date.now();
      try {
        const result = await browser.tabs.sendMessage(tabId, {
          type: "zamery_browser_firefox_act",
          document_id: ref.d,
          node_id: ref.n,
          action: params.action,
          value: params.value,
          text: params.text,
          key: params.key,
          v0c_test_delay_after_ms: params.v0c_test_delay_after_ms,
        }, actionTarget);
        if (result?.error) {
          if (result.error.code === "USER_TAKEOVER_REQUIRED") userTakeover(result.error.reason || "credential_field");
          return { outcome: "not_started", error: result.error };
        }
        if (params.v0c_test_reload_after_action === true) {
          const current = await browser.tabs.get(tabId);
          if (!String(current?.url || "").startsWith("http://127.0.0.1:18765/")) {
            throw newError("V0C_TEST_HOOK_REFUSED", "test reload hook is restricted to the V0c fixture");
          }
          browser.runtime.reload();
          await new Promise(() => {});
        }
        const cancelRequestedAfterStart = cancelledRequests.has(requestId);
        return {
          outcome: "completed",
          result,
          cancellation: cancelRequestedAfterStart
            ? { requested: true, effect: "none_after_start" }
            : { requested: false },
        };
      } catch (error) {
        // Dispatch happened; the effect may or may not have. The human reviews before the agent writes again.
        userTakeover("outcome_unknown");
        throw newError("BROWSER_ACTION_RESPONSE_LOST", `action response unavailable: ${error?.message || error}`, undefined, { outcome: "outcome_unknown" });
      }
    } finally {
      cancelledRequests.delete(requestId);
      requestPhases.delete(requestId);
    }
  });
}

async function normalWindowForNewTab() {
  const focused = await browser.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (!focused || focused.incognito === true || (focused.type && focused.type !== "normal")) {
    throw denial("BROWSER_CONTEXT_UNAVAILABLE", "no_normal_window_available", "no non-private normal Firefox window is available for a new tab");
  }
  return focused;
}

function requireAction(action) {
  if (!binding?.actions.includes(action)) throw denial("BROWSER_AUTHORIZATION_REQUIRED", `${action}_not_granted`);
}

function registerOwnedTab(tab, origin) {
  ownedTabIds.add(tab.id);
  binding.scope.tabs = {
    ...binding.scope.tabs,
    [String(tab.id)]: { origin, partition: tab.cookieStoreId ?? null, owned: true },
  };
  bumpRevision();
}

async function createOwnedTab(params) {
  requireAction("create_tab");
  const rawUrl = String(params.url || "about:blank");
  const origin = originForUrl(rawUrl);
  if (rawUrl !== "about:blank" && !origin) {
    throw denial("BROWSER_CONTEXT_UNAVAILABLE", "unsupported_destination_scheme", "only http(s) destinations may be opened");
  }
  const window = await normalWindowForNewTab();
  if (params.active) markAgentActivation();
  const tab = await browser.tabs.create({ url: rawUrl, active: Boolean(params.active), windowId: window.id });
  if (typeof tab.id !== "number") throw newError("BROWSER_REQUEST_FAILED", "created tab has no id");
  registerOwnedTab(tab, origin);
  return { outcome: "completed", context_id: contextIdFor(tab.id), ownership: "provider-owned" };
}

async function closeOwnedTab(params) {
  const { tabId } = await contextAuthorization(params.context_id, "close_owned_tab");
  if (!ownedTabIds.has(tabId)) throw newError("CONTEXT_NOT_OWNED", "refusing to close user-owned tab");
  await browser.tabs.remove(tabId);
  return { outcome: "completed" };
}

// ---- popup (trusted UI) -------------------------------------------------------------------------------

const POPUP_GRANT_MAX_TABS = 64;

async function eligibleTabForGrant(tabId) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || typeof tab.id !== "number" || tab.incognito === true) return null;
  const origin = originForUrl(tab.url);
  if (!origin) return null;
  const window = await browser.windows.get(tab.windowId).catch(() => null);
  if (!window || window.incognito === true || (window.type && window.type !== "normal")) return null;
  return { tab, origin };
}

async function grantFromPopup(message) {
  const status = () => authorizationStatus({ detail: "popup" });
  ensureAuthorityCurrent();
  if (!currentHostSessionId) return { ok: false, error: "native_host_session_not_ready", ...status() };
  if (currentHostProtocolVersion !== PROTOCOL_VERSION) return { ok: false, error: "native_host_protocol_version_mismatch", ...status() };
  const rebinding = Boolean(consent && !binding);
  if (consent && binding) return { ok: false, error: "grant_already_active_revoke_first", ...status() };

  let duration = null;
  if (!rebinding) {
    duration = Policy.normalizeDuration(message.duration, { allowCustom: message.allow_custom_duration === true });
    if (!duration.ok) return { ok: false, error: duration.error, ...status() };
  } else if (Policy.clockRegressed(consent, Date.now()) && message.confirm_clock_change !== true) {
    return { ok: false, error: "clock_regression_confirmation_required", ...status() };
  }

  const audienceId = typeof message.audience_id === "string" && message.audience_id ? message.audience_id : consent?.enrolledConsumerId ?? null;
  if (!audienceId) return { ok: false, error: "no_local_agent_selected", ...status() };
  if (!seenAudiences.has(audienceId) && audienceId !== consent?.enrolledConsumerId) {
    return { ok: false, error: "local_agent_not_connected", ...status() };
  }

  let tabIds = Array.isArray(message.tab_ids) ? message.tab_ids.filter((value) => Number.isInteger(value) && value >= 0) : [];
  const groupIds = Array.isArray(message.group_ids) ? [...new Set(message.group_ids.filter((value) => Number.isInteger(value) && value >= 0))] : [];
  if (groupIds.length > 0 && !groupsApiAvailable()) return { ok: false, error: "tab_groups_api_unavailable", ...status() };
  if (tabIds.length === 0 && groupIds.length === 0) {
    const active = await browser.tabs.query({ active: true, currentWindow: true });
    if (typeof active[0]?.id === "number") tabIds = [active[0].id];
  }
  tabIds = [...new Set(tabIds)].slice(0, POPUP_GRANT_MAX_TABS);
  if (tabIds.length === 0 && groupIds.length === 0) return { ok: false, error: "no_shareable_tab_selected", ...status() };

  const scopeTabs = {};
  const scopeGroups = {};
  const groupPolicy = Policy.normalizeGroupPolicy(message.group_policy);
  for (const tabId of tabIds) {
    const eligible = await eligibleTabForGrant(tabId);
    if (eligible) scopeTabs[String(tabId)] = { origin: eligible.origin, partition: eligible.tab.cookieStoreId ?? null };
  }
  for (const nativeGroupId of groupIds) {
    const native = await browser.tabGroups.get(nativeGroupId).catch(() => null);
    if (!native) continue;
    const window = await browser.windows.get(native.windowId).catch(() => null);
    if (!window || window.incognito === true || (window.type && window.type !== "normal")) continue;
    const handle = newGroupHandle();
    scopeGroups[handle] = { nativeGroupId, policy: groupPolicy, windowId: native.windowId, revision: 1 };
    // Membership is frozen here. Direct tab selections keep their direct authority.
    for (const member of await browser.tabs.query({ groupId: nativeGroupId })) {
      if (scopeTabs[String(member.id)]) continue;
      const eligible = await eligibleTabForGrant(member.id);
      if (eligible) scopeTabs[String(member.id)] = { origin: eligible.origin, partition: eligible.tab.cookieStoreId ?? null, viaGroup: handle };
    }
  }
  if (Object.keys(scopeTabs).length === 0) return { ok: false, error: "selected_tabs_are_not_supported_web_pages", ...status() };
  const scopeKind = Object.keys(scopeGroups).length > 0 ? "group" : "tabs";

  const now = Date.now();
  const origins = Object.values(scopeTabs).map((entry) => entry.origin);
  const nextConsent = Policy.buildConsent({
    now,
    grantId: crypto.randomUUID(),
    trustedProfileId: profileId,
    audienceId,
    duration,
    actions: message.actions ?? (rebinding ? consent.actions : undefined),
    scopeSummary: { kind: scopeKind, count: Object.keys(scopeTabs).length, origins },
    groupPolicy,
    previous: rebinding ? consent : null,
  });
  consent = { ...nextConsent, enrolledConsumerId: audienceId };
  binding = {
    instanceId: crypto.randomUUID(),
    grantId: consent.grantId,
    grantRevision: consent.grantRevision,
    hostSessionId: currentHostSessionId,
    browserRunEpoch,
    audienceId,
    actions: [...consent.actions],
    groupPolicy: consent.groupPolicy,
    scope: { kind: scopeKind, tabs: scopeTabs, groups: scopeGroups },
    monotonicDeadline: consent.mode === "fixed" ? performance.now() + (consent.expiresAt - now) : null,
  };
  lastEnd = null;
  ownedTabIds.clear();
  if (typeof agentMovedTabs !== "undefined") agentMovedTabs.clear();
  clearCachesForAuthorityChange();
  applyControl({ type: "grant" });
  await persistConsent();
  return { ok: true, ...status() };
}

function popupOnly(sender) {
  return sender?.id === browser.runtime.id && sender?.url === browser.runtime.getURL("popup.html") && !sender?.tab;
}

async function confirmOrigin(tabId) {
  if (!binding || !pendingOriginChanges[String(tabId)]) return { ok: false, error: "no_pending_origin_change" };
  const eligible = await eligibleTabForGrant(tabId);
  if (!eligible) return { ok: false, error: "tab_not_shareable" };
  const key = String(tabId);
  binding.scope.tabs = { ...binding.scope.tabs, [key]: { ...binding.scope.tabs[key], origin: eligible.origin } };
  delete pendingOriginChanges[key];
  bumpRevision();
  return { ok: true };
}

/** The user widens an active grant with more tabs. The deadline and actions stay exactly as approved. */
async function addTabsFromPopup(message) {
  const status = () => authorizationStatus({ detail: "popup" });
  ensureAuthorityCurrent();
  if (!binding || !consent) return { ok: false, error: "not_granted", ...status() };
  const requested = Array.isArray(message.tab_ids) ? message.tab_ids.filter((value) => Number.isInteger(value) && value >= 0) : [];
  if (requested.length === 0) return { ok: false, error: "no_shareable_tab_selected", ...status() };
  let added = 0;
  for (const tabId of [...new Set(requested)]) {
    if (Object.keys(binding.scope.tabs).length >= POPUP_GRANT_MAX_TABS) break;
    const eligible = await eligibleTabForGrant(tabId);
    if (!eligible) continue;
    const key = String(tabId);
    const existing = binding.scope.tabs[key];
    // An explicit selection upgrades group-derived access to direct access.
    if (existing && !existing.viaGroup) continue;
    binding.scope.tabs = { ...binding.scope.tabs, [key]: { origin: eligible.origin, partition: eligible.tab.cookieStoreId ?? null, ...(existing?.owned ? { owned: true } : {}) } };
    added += 1;
  }
  if (added === 0) return { ok: false, error: "selected_tabs_are_not_supported_web_pages", ...status() };
  const origins = Object.values(binding.scope.tabs).map((entry) => entry.origin).filter(Boolean);
  consent = { ...consent, scopeSummary: { ...consent.scopeSummary, count: Object.keys(binding.scope.tabs).length, origins: [...new Set(origins)].slice(0, 32) } };
  bumpRevision();
  return { ok: true, ...status() };
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "zamery_browser_firefox_interaction" || message.type === "zamery_browser_firefox_interaction_batch") {
    // From our own content script on an armed (claimed) tab only.
    if (sender?.id !== browser.runtime.id || typeof sender?.tab?.id !== "number") return undefined;
    const tabId = sender.tab.id;
    interactionGenerations.set(tabId, (interactionGenerations.get(tabId) || 0) + 1);
    if (control.state === "agent_claimed" && control.claimedContextId === contextIdFor(tabId)) userTakeover("human_interaction");
    return undefined;
  }

  if (message.type === "zamery_browser_firefox_auth_status" || message.type === "zamery_v0c_auth_status") {
    return Promise.resolve(authorizationStatus({ detail: popupOnly(sender) ? "popup" : "consumer", audienceId: null }));
  }

  if (!popupOnly(sender)) return undefined;

  if (message.type === "zamery_browser_firefox_grant" || message.type === "zamery_v0c_grant") {
    return grantFromPopup(message);
  }

  if (message.type === "zamery_browser_firefox_revoke" || message.type === "zamery_v0c_revoke") {
    endAuthority("user_revoked");
    return Promise.resolve({ ok: true, ...authorizationStatus({ detail: "popup" }) });
  }

  if (message.type === "zamery_browser_firefox_takeover") {
    const result = userTakeover("user_takeover");
    return Promise.resolve({ ok: result.ok, ...authorizationStatus({ detail: "popup" }) });
  }

  if (message.type === "zamery_browser_firefox_resume") {
    const result = applyControl({ type: "resume" });
    return Promise.resolve({ ok: result.ok, error: result.ok ? undefined : result.reason, ...authorizationStatus({ detail: "popup" }) });
  }

  if (message.type === "zamery_browser_firefox_confirm_origin") {
    return confirmOrigin(Number(message.tab_id)).then(async (result) => ({ ...result, ...authorizationStatus({ detail: "popup" }) }));
  }

  if (message.type === "zamery_browser_firefox_add_tabs") {
    return addTabsFromPopup(message);
  }

  if (message.type === "zamery_browser_firefox_exclude_tab") {
    removeTabFromScope(Number(message.tab_id), "tab_excluded_by_user");
    return Promise.resolve({ ok: true, ...authorizationStatus({ detail: "popup" }) });
  }

  return undefined;
});

// ---- browser topology events: every event is an invalidation, never a source of authority ---------------------

browser.tabs.onRemoved.addListener((tabId) => {
  if (binding?.scope?.tabs?.[String(tabId)]) removeTabFromScope(tabId, "tab_closed");
  else {
    ownedTabIds.delete(tabId);
    dropTabCaches(tabId);
  }
});

browser.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
  if (binding?.scope?.tabs?.[String(removedTabId)]) removeTabFromScope(removedTabId, "tab_replaced");
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.groupId !== undefined && typeof reconcileGroupsAfterEvent === "function") void reconcileGroupsAfterEvent("tab_group_changed", tabId);
  const entry = binding?.scope?.tabs?.[String(tabId)];
  if (!entry) return;
  if (changeInfo.url !== undefined) {
    dropTabCaches(tabId);
    const origin = originForUrl(changeInfo.url);
    const claimedHere = control.state === "agent_claimed" && control.claimedContextId === contextIdFor(tabId);
    if (origin !== entry.origin) {
      pendingOriginChanges[String(tabId)] = { from: entry.origin, to: origin };
      if (claimedHere) userTakeover("origin_changed");
    } else if (claimedHere && Date.now() - lastAgentMutationAt > AGENT_NAVIGATION_ATTRIBUTION_MS) {
      userTakeover("manual_navigation");
    }
  }
});

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (control.state !== "agent_claimed" || Date.now() < agentActivationUntil) return;
  const claimed = tabIdFromContext(control.claimedContextId);
  if (claimed === tabId) return;
  void browser.tabs.get(claimed).then((tab) => {
    if (tab.windowId === windowId) userTakeover("tab_switched");
  }).catch(() => undefined);
});

browser.windows.onFocusChanged.addListener((windowId) => {
  if (control.state !== "agent_claimed" || windowId === browser.windows.WINDOW_ID_NONE || Date.now() < agentActivationUntil) return;
  void browser.tabs.get(tabIdFromContext(control.claimedContextId)).then((tab) => {
    if (tab.windowId !== windowId) userTakeover("window_switched");
  }).catch(() => undefined);
});
