// Pure companion policy: consent lifetime, scope evaluation and the human <-> agent control machine.
// No browser APIs here. Loaded before background.js in the extension and imported directly by Node tests.
(function register(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ZameryPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DURATION_PRESET_DAYS = Object.freeze([1, 3, 7, 14, 30]);
  const DURATION_MAX_CUSTOM_DAYS = 30;
  // Wall-clock regressions larger than this make a persisted deadline untrustworthy.
  const CLOCK_REGRESSION_TOLERANCE_MS = 5 * 60 * 1000;
  const CONSENT_SCHEMA_VERSION = 1;

  const ACTIONS = Object.freeze(["inspect", "interact", "capture", "reorganize", "create_tab", "close_owned_tab"]);
  const DEFAULT_ACTIONS = Object.freeze(["inspect", "interact", "capture"]);
  const GROUP_POLICIES = Object.freeze(["membership_snapshot", "follow_group"]);
  const CONTROL_MODES = Object.freeze(["interactive", "background"]);

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // ---- duration -------------------------------------------------------------------------------

  function normalizeDuration(input, options = {}) {
    const raw = isPlainObject(input) ? input : { mode: "session" };
    const mode = raw.mode === "fixed" ? "fixed" : raw.mode === undefined || raw.mode === "session" ? "session" : null;
    if (mode === null) return { ok: false, error: "invalid_authorization_duration" };
    if (mode === "session") return { ok: true, mode: "session", days: null };
    const days = raw.days;
    if (!Number.isSafeInteger(days) || days < 1 || days > DURATION_MAX_CUSTOM_DAYS) {
      return { ok: false, error: "invalid_authorization_duration" };
    }
    if (!DURATION_PRESET_DAYS.includes(days) && options.allowCustom !== true) {
      return { ok: false, error: "custom_authorization_duration_requires_explicit_intent" };
    }
    return { ok: true, mode: "fixed", days };
  }

  function computeExpiry(now, days) {
    return now + days * DAY_MS;
  }

  function normalizeActions(requested) {
    const list = Array.isArray(requested) ? requested.filter((value) => ACTIONS.includes(value)) : [];
    const unique = [...new Set(list.length > 0 ? list : DEFAULT_ACTIONS)];
    // Reading is the floor: acting on a page the agent cannot inspect has no safe meaning.
    if (!unique.includes("inspect")) unique.unshift("inspect");
    return unique;
  }

  function normalizeGroupPolicy(value) {
    return GROUP_POLICIES.includes(value) ? value : "membership_snapshot";
  }

  function normalizeControlMode(value) {
    return CONTROL_MODES.includes(value) ? value : "interactive";
  }

  // ---- consent --------------------------------------------------------------------------------

  /**
   * ConsentGrant: what the user agreed to and for how long. It deliberately holds no live tab or group
   * identity: those are LiveBinding facts that must be re-established after any restart.
   */
  function buildConsent({ now, grantId, trustedProfileId, audienceId, duration, actions, scopeSummary, groupPolicy, controlMode, previous }) {
    const rebinding = Boolean(previous);
    return {
      schemaVersion: CONSENT_SCHEMA_VERSION,
      grantId: rebinding ? previous.grantId : grantId,
      grantRevision: rebinding ? previous.grantRevision + 1 : 1,
      trustedProfileId,
      enrolledConsumerId: audienceId ?? null,
      issuedAt: rebinding ? previous.issuedAt : now,
      mode: rebinding ? previous.mode : duration.mode,
      durationDays: rebinding ? previous.durationDays : duration.days,
      expiresAt: rebinding ? previous.expiresAt : duration.mode === "fixed" ? computeExpiry(now, duration.days) : null,
      actions: normalizeActions(actions),
      scopeSummary: {
        kind: scopeSummary?.kind === "group" ? "group" : "tabs",
        count: Number.isSafeInteger(scopeSummary?.count) ? scopeSummary.count : 0,
        origins: Array.isArray(scopeSummary?.origins) ? [...new Set(scopeSummary.origins.filter((o) => typeof o === "string"))].slice(0, 32) : [],
      },
      groupPolicy: normalizeGroupPolicy(groupPolicy),
      controlMode: rebinding ? normalizeControlMode(previous.controlMode) : normalizeControlMode(controlMode),
      navigationPolicy: "current_origin",
      restartPolicy: "explicit_rebind",
      lastSeenAt: now,
    };
  }

  function consentExpired(consent, now) {
    return consent?.mode === "fixed" && !(typeof consent.expiresAt === "number" && consent.expiresAt > now);
  }

  /** A fixed deadline cannot be trusted if the wall clock moved backwards since we last looked. */
  function clockRegressed(consent, now) {
    return consent?.mode === "fixed"
      && typeof consent.lastSeenAt === "number"
      && now + CLOCK_REGRESSION_TOLERANCE_MS < consent.lastSeenAt;
  }

  /** Validate a consent loaded from storage. Anything unfamiliar is discarded, never repaired. */
  function parseStoredConsent(value) {
    if (!isPlainObject(value) || value.schemaVersion !== CONSENT_SCHEMA_VERSION) return null;
    if (typeof value.grantId !== "string" || typeof value.trustedProfileId !== "string") return null;
    if (value.mode !== "fixed") return null; // session consent is never persisted
    if (!Number.isSafeInteger(value.durationDays) || value.durationDays < 1 || value.durationDays > DURATION_MAX_CUSTOM_DAYS) return null;
    if (!Number.isFinite(value.issuedAt) || !Number.isFinite(value.expiresAt)) return null;
    if (value.expiresAt - value.issuedAt !== value.durationDays * DAY_MS) return null;
    if (!Number.isSafeInteger(value.grantRevision) || value.grantRevision < 1) return null;
    return {
      ...value,
      actions: normalizeActions(value.actions),
      groupPolicy: normalizeGroupPolicy(value.groupPolicy),
      controlMode: normalizeControlMode(value.controlMode),
      navigationPolicy: "current_origin",
      restartPolicy: "explicit_rebind",
    };
  }

  // ---- scope evaluation -------------------------------------------------------------------------

  function originForUrl(url) {
    try {
      const parsed = new URL(String(url || ""));
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
    } catch {
      return null;
    }
  }

  /**
   * Decide whether `tab` may be touched with `action` under `scope`.
   * scope.tabs[tabId] = { origin, partition, viaGroup?: groupHandle }
   * scope.groups[handle] = { nativeGroupId, policy, windowId }
   * Returns { ok: true } or { ok: false, code, reason }.
   */
  function evaluateTabAccess({ scope, actions, pendingOrigins = {} }, tab, action) {
    const denied = (reason, code = "BROWSER_AUTHORIZATION_REQUIRED") => ({ ok: false, code, reason });
    if (!scope || !tab || typeof tab.id !== "number") return denied("outside_scope");
    const entry = scope.tabs?.[String(tab.id)];
    if (!entry) return denied("outside_scope");
    if (!Array.isArray(actions) || !actions.includes(action)) return denied("action_outside_scope");
    if (tab.incognito === true) return denied("private_window_denied");
    if (tab.discarded === true) return { ok: false, code: "BROWSER_CONTEXT_UNAVAILABLE", reason: "tab_discarded" };
    if (entry.viaGroup) {
      const group = scope.groups?.[entry.viaGroup];
      if (!group || tab.groupId !== group.nativeGroupId) return denied("left_authorized_group");
    }
    if (entry.partition && tab.cookieStoreId && entry.partition !== tab.cookieStoreId) return denied("partition_changed");
    const origin = originForUrl(tab.url);
    if (!origin) return denied("restricted_or_unsupported_page");
    if (pendingOrigins[String(tab.id)] || entry.origin !== origin) return denied("origin_changed_confirmation_required");
    return { ok: true };
  }

  // ---- control machine ------------------------------------------------------------------------

  const CONTROL_STATES = Object.freeze(["no_access", "shared_idle", "agent_claimed", "user_control", "rebinding"]);

  function createControl(overrides = {}) {
    return {
      state: "no_access",
      claimGeneration: 0,
      claimedContextId: null,
      claimedAudienceId: null,
      leaseId: null,
      reason: null,
      resumeRequested: false,
      updatedAt: 0,
      ...overrides,
    };
  }

  function next(control, patch, now) {
    return { ...control, ...patch, claimGeneration: control.claimGeneration + 1, updatedAt: now };
  }

  /**
   * Pure transition function. Returns { ok: true, control } or { ok: false, code, reason }.
   * Every state change that could invalidate an outstanding observation bumps claimGeneration.
   */
  function transition(control, event, now = Date.now()) {
    const refuse = (reason, code = "BROWSER_AUTHORIZATION_REQUIRED") => ({ ok: false, code, reason });
    switch (event.type) {
      case "grant":
        return { ok: true, control: next(control, { state: "shared_idle", claimedContextId: null, claimedAudienceId: null, leaseId: null, reason: null, resumeRequested: false }, now) };
      case "rebind_required":
        return { ok: true, control: next(control, { state: "rebinding", claimedContextId: null, claimedAudienceId: null, leaseId: null, reason: event.reason || "restart", resumeRequested: false }, now) };
      case "revoke":
        return { ok: true, control: next(control, { state: "no_access", claimedContextId: null, claimedAudienceId: null, leaseId: null, reason: event.reason || "revoked", resumeRequested: false }, now) };
      case "claim": {
        if (control.state === "no_access" || control.state === "rebinding") return refuse("not_granted");
        if (control.state === "user_control") return refuse("user_control");
        if (control.state === "agent_claimed" && control.claimedAudienceId !== event.audienceId) return refuse("claimed_by_other_consumer");
        return {
          ok: true,
          control: next(control, { state: "agent_claimed", claimedContextId: event.contextId, claimedAudienceId: event.audienceId, leaseId: event.leaseId, reason: null, resumeRequested: false }, now),
        };
      }
      case "release":
        if (control.state !== "agent_claimed") return { ok: true, control };
        return { ok: true, control: next(control, { state: "shared_idle", claimedContextId: null, claimedAudienceId: null, leaseId: null, reason: event.reason || "released" }, now) };
      case "takeover":
        if (control.state === "no_access" || control.state === "rebinding") return refuse("not_granted");
        return { ok: true, control: next(control, { state: "user_control", claimedContextId: null, claimedAudienceId: null, leaseId: null, reason: event.reason || "user_takeover", resumeRequested: false }, now) };
      case "request_resume":
        if (control.state !== "user_control") return refuse("not_in_user_control");
        // The agent can only ask. Only the user's resume releases user control.
        return { ok: true, control: { ...control, resumeRequested: true, updatedAt: now } };
      case "resume":
        if (control.state !== "user_control") return refuse("not_in_user_control");
        return { ok: true, control: next(control, { state: "shared_idle", claimedContextId: null, claimedAudienceId: null, leaseId: null, reason: null, resumeRequested: false }, now) };
      case "context_gone":
        if (control.state === "agent_claimed" && control.claimedContextId === event.contextId) {
          return { ok: true, control: next(control, { state: "shared_idle", claimedContextId: null, claimedAudienceId: null, leaseId: null, reason: "claimed_context_closed" }, now) };
        }
        return { ok: true, control };
      default:
        return refuse(`unknown_event:${event.type}`, "INTERNAL");
    }
  }

  /** May the agent dispatch a write against `contextId` with an observation taken at `claimGeneration`? */
  function checkWriteClaim(control, { contextId, audienceId, claimGeneration }) {
    if (control.state === "user_control") return { ok: false, code: "BROWSER_AUTHORIZATION_REQUIRED", reason: "user_control" };
    if (control.state !== "agent_claimed") return { ok: false, code: "BROWSER_AUTHORIZATION_REQUIRED", reason: "claim_required" };
    if (control.claimedAudienceId !== audienceId) return { ok: false, code: "BROWSER_AUTHORIZATION_REQUIRED", reason: "claimed_by_other_consumer" };
    if (control.claimedContextId !== contextId) return { ok: false, code: "STALE_ELEMENT_REF", reason: "claim_context_changed" };
    if (control.claimGeneration !== claimGeneration) return { ok: false, code: "STALE_ELEMENT_REF", reason: "claim_changed" };
    return { ok: true };
  }

  return {
    DAY_MS,
    DURATION_PRESET_DAYS,
    DURATION_MAX_CUSTOM_DAYS,
    CLOCK_REGRESSION_TOLERANCE_MS,
    CONSENT_SCHEMA_VERSION,
    ACTIONS,
    DEFAULT_ACTIONS,
    GROUP_POLICIES,
    CONTROL_MODES,
    CONTROL_STATES,
    normalizeDuration,
    computeExpiry,
    normalizeActions,
    normalizeGroupPolicy,
    normalizeControlMode,
    buildConsent,
    consentExpired,
    clockRegressed,
    parseStoredConsent,
    originForUrl,
    evaluateTabAccess,
    createControl,
    transition,
    checkWriteClaim,
  };
});
