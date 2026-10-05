import { randomUUID } from "node:crypto";

import {
  BROWSER_ARTIFACT_LIMITS_V1,
  BROWSER_ARTIFACT_PROVIDER_V1,
  BROWSER_AUTHORIZATION_PROVIDER_V1,
  BROWSER_CONTROL_PROVIDER_V1,
  BROWSER_CONTROL_RECEIPT_SCHEMA_V1,
  BROWSER_PROVIDER_V2,
  BROWSER_PROVIDER_V2_COMMON_CAPABILITIES,
  BROWSER_PROVIDER_V2_RECEIPT_SCHEMA,
  BROWSER_PROVIDER_V2_SEMANTICS_SCHEMA,
  BROWSER_TAB_GROUP_PROVIDER_V1,
  BROWSER_TAB_PROVIDER_V1,
  BROWSER_TAB_PROVIDER_V1_CAPABILITIES,
  validateBrowserActionReceiptV2,
  type BrowserActionCapabilityIdV2,
  type BrowserActionSemanticsV2,
  type BrowserActionV2,
  type BrowserArtifactBytesV1,
  type BrowserArtifactDescriptorV1,
  type BrowserArtifactProviderV1,
  type BrowserScreenshotRequestV1,
  type BrowserAuthorizationActionV1,
  type BrowserAuthorizationDetailV1,
  type BrowserAuthorizationProviderV1,
  type BrowserAuthorizationStateV1,
  type BrowserClaimRequestV1,
  type BrowserClaimValueV1,
  type BrowserContextCapabilitiesV2,
  type BrowserContextSummaryV2,
  type BrowserControlErrorCodeV1,
  type BrowserControlErrorV1,
  type BrowserControlProviderV1,
  type BrowserControlReceiptV1,
  type BrowserControlResultV1,
  type BrowserControlStateNameV1,
  type BrowserControlStateV1,
  type BrowserControlTargetV1,
  type BrowserDocumentProvenanceV2,
  type BrowserFreshnessV2,
  type BrowserMutationOutcomeV2,
  type BrowserMutationRequestV2,
  type BrowserMutationResultV2,
  type BrowserMutationStatusStateV1,
  type BrowserMutationStatusV1,
  type BrowserOperationOptionsV2,
  type BrowserProviderDeclarationV2,
  type BrowserProviderErrorCodeV2,
  type BrowserProviderErrorV2,
  type BrowserProviderStatusV2,
  type BrowserProviderV2,
  type BrowserSnapshotV2,
  type BrowserTabCapabilityIdV1,
  type BrowserTabGroupActivateValueV1,
  type BrowserTabGroupCreateRequestV1,
  type BrowserTabGroupMembershipRequestV1,
  type BrowserTabGroupMoveRequestV1,
  type BrowserTabGroupMutationBaseV1,
  type BrowserTabGroupProviderV1,
  type BrowserTabGroupUpdateRequestV1,
  type BrowserTabGroupV1,
  type BrowserTabContextRequestV1,
  type BrowserTabCreateRequestV1,
  type BrowserTabNavigateRequestV1,
  type BrowserTabProviderV1,
  type BrowserTabValueV1,
  type BrowserTargetProvenanceV2,
} from "@zamery/browser-provider";

import { createHash } from "node:crypto";

import { ArtifactError, ArtifactStore } from "./artifact-store.js";
import { normalizeAudienceId } from "./audience.js";
import { isFirefoxBrokerTransportError, sendFirefoxBrokerRequest } from "./client.js";
import { FirefoxSessionSelectionError, listLiveFirefoxSessions, selectFirefoxSession } from "./session.js";
import type { FirefoxBrokerResponse, FirefoxSessionReceipt } from "./protocol.js";
import type { FirefoxBrowserProviderOptions } from "./provider.js";

const PROVIDER_ID = "firefox";
const MAX_TRACKED_REFS = 4_096;

const ACTION_SEMANTICS: Readonly<Record<BrowserActionCapabilityIdV2, BrowserActionSemanticsV2>> = {
  "action.click": {
    schemaVersion: BROWSER_PROVIDER_V2_SEMANTICS_SCHEMA,
    action: "action.click",
    mechanism: "dom-synthetic",
    domEventTrustExpectation: "untrusted",
    userActivation: "not-capable",
    defaultBehavior: [
      { domain: "activation", support: "not-guaranteed" },
      { domain: "navigation", support: "not-guaranteed" },
    ],
  },
  "action.fill": {
    schemaVersion: BROWSER_PROVIDER_V2_SEMANTICS_SCHEMA,
    action: "action.fill",
    mechanism: "dom-synthetic",
    domEventTrustExpectation: "untrusted",
    userActivation: "not-capable",
    defaultBehavior: [{ domain: "text-editing", support: "not-guaranteed" }],
  },
  "action.type": {
    schemaVersion: BROWSER_PROVIDER_V2_SEMANTICS_SCHEMA,
    action: "action.type",
    mechanism: "dom-synthetic",
    domEventTrustExpectation: "untrusted",
    userActivation: "not-capable",
    defaultBehavior: [{ domain: "text-editing", support: "not-guaranteed" }],
  },
  "action.key": {
    schemaVersion: BROWSER_PROVIDER_V2_SEMANTICS_SCHEMA,
    action: "action.key",
    mechanism: "dom-synthetic",
    domEventTrustExpectation: "untrusted",
    userActivation: "not-capable",
    defaultBehavior: [{ domain: "keyboard-default", support: "not-guaranteed" }],
  },
};

const DECLARATION: BrowserProviderDeclarationV2 = {
  protocolVersion: BROWSER_PROVIDER_V2,
  semanticsSchemaVersion: BROWSER_PROVIDER_V2_SEMANTICS_SCHEMA,
  providerId: PROVIDER_ID,
  commonCapabilities: BROWSER_PROVIDER_V2_COMMON_CAPABILITIES,
  actions: Object.values(ACTION_SEMANTICS),
  providerExtensions: [{
    namespace: "firefox",
    semanticId: "firefox/dom-synthetic-actions",
    version: 1,
    fields: {
      refValidation: "browser-side-before-mutation",
      topFrameOnly: true,
      domEventTrust: "untrusted",
    },
  }],
};

const PROVIDER_ERROR_CODES = new Set<BrowserProviderErrorCodeV2>([
  "BROWSER_CONTEXT_NOT_FOUND",
  "BROWSER_CONTEXT_GONE",
  "BROWSER_CONTEXT_UNAVAILABLE",
  "BROWSER_INSTANCE_AMBIGUOUS",
  "BROWSER_INSTANCE_NOT_FOUND",
  "STALE_ELEMENT_REF",
  "OBSERVATION_FRESHNESS_UNKNOWN",
  "UNSUPPORTED_CAPABILITY",
  "UNSUPPORTED_INPUT_SEMANTICS",
  "BROWSER_PROTOCOL_MISMATCH",
  "BROWSER_REQUEST_TIMEOUT",
  "BROWSER_REQUEST_CANCELLED",
  "BROWSER_PROVIDER_ERROR",
  "BROWSER_AUTHORIZATION_REQUIRED",
  "REQUEST_ID_CONFLICT",
  "MUTATION_OUTCOME_UNKNOWN",
  "BROWSER_ACTION_RESPONSE_LOST",
  "CONTEXT_NOT_OWNED",
  "PROVIDER_SESSION_CHANGED",
]);

interface RawControlSummary {
  state?: unknown;
  claim_generation?: unknown;
  claimed_context_id?: unknown;
  claimed_by_you?: unknown;
  reason?: unknown;
  resume_requested?: unknown;
}

interface RawAuthorizationStatus {
  state?: unknown;
  reason?: unknown;
  current_host_session_id?: unknown;
  granted_host_session_id?: unknown;
  granted_at?: unknown;
  expires_at?: unknown;
  grant_revision?: unknown;
  grant_id?: unknown;
  binding_token?: unknown;
  duration_mode?: unknown;
  duration_days?: unknown;
  scope_kind?: unknown;
  scope_count?: unknown;
  actions?: unknown;
  group_policy?: unknown;
  protocol_compatible?: unknown;
  control?: RawControlSummary;
}

interface RawStatus {
  companion_extension_version?: unknown;
  features?: Record<string, unknown>;
  authorization?: RawAuthorizationStatus;
}

interface RawContextAvailability {
  inspect?: unknown;
  act?: unknown;
  reason?: unknown;
}

interface RawContext {
  context_id?: unknown;
  title?: unknown;
  url?: unknown;
  active?: unknown;
  ownership?: unknown;
  availability?: RawContextAvailability;
}

interface RawMutationStatus {
  request_id?: unknown;
  state?: unknown;
  outcome?: unknown;
  op?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  replay_horizon_ms?: unknown;
}

interface RawContextsResult {
  browser_instance_id?: unknown;
  contexts?: unknown;
}

interface RawSnapshotNode {
  ref?: unknown;
  role?: unknown;
  name?: unknown;
  tag?: unknown;
  type?: unknown;
  value?: unknown;
  contenteditable?: unknown;
  credential?: unknown;
  checked?: unknown;
  disabled?: unknown;
}

interface RawSnapshotCoverage {
  truncated?: unknown;
  node_limit?: unknown;
  values_exported?: unknown;
  hidden_controls_excluded?: unknown;
}

interface RawSnapshotResult {
  context_id?: unknown;
  snapshot_id?: unknown;
  document_id?: unknown;
  browser_document_id?: unknown;
  document_identity?: unknown;
  url?: unknown;
  title?: unknown;
  coverage?: RawSnapshotCoverage;
  nodes?: unknown;
}

interface RawMutationResult {
  outcome?: unknown;
  result?: {
    mechanism?: unknown;
    observed_is_trusted?: unknown;
    user_activation_before?: unknown;
    user_activation_after?: unknown;
  };
  error?: {
    code?: unknown;
    message?: unknown;
    reason?: unknown;
  };
  cancellation?: {
    requested?: unknown;
    effect?: unknown;
  };
}

interface TrackedRef {
  observationId: string;
  target: BrowserTargetProvenanceV2;
}


function groupFrom(raw: unknown): BrowserTabGroupV1 {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    handle: stringOrEmpty(value.handle),
    revision: typeof value.revision === "number" ? value.revision : 0,
    windowId: typeof value.window_id === "number" ? value.window_id : null,
    title: stringOrEmpty(value.title),
    color: stringOrEmpty(value.color) || "grey",
    collapsed: value.collapsed === true,
    memberContextIds: stringList(value.member_context_ids),
    incompleteMembership: value.incomplete_membership === true,
    policy: value.policy === "follow_group" ? "follow_group" : "membership_snapshot",
  };
}

/**
 * A journal replay keeps only safe identifiers, not the full group view. Rebuild what is known and let the
 * caller re-read the group (getTabGroup) when it needs title/color/membership.
 */
function groupFromResult(result: Record<string, unknown>): BrowserTabGroupV1 {
  if (result.group && typeof result.group === "object") return groupFrom(result.group);
  return groupFrom({ handle: result.group_handle, revision: result.group_revision, member_context_ids: result.member_context_ids });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Mint a request id the native host can age-check: `zq1-<ms in base36>-<random>`. Consumers should use one
 * stable id per logical mutation so a reconnect can reconcile it instead of re-running it.
 */
export function createFirefoxRequestId(now: number = Date.now()): string {
  return `zq1-${now.toString(36).padStart(8, "0")}-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorCode(value: unknown): BrowserProviderErrorCodeV2 {
  if (value === "CONTEXT_UNAVAILABLE") return "BROWSER_CONTEXT_UNAVAILABLE";
  if (typeof value === "string" && PROVIDER_ERROR_CODES.has(value as BrowserProviderErrorCodeV2)) {
    return value as BrowserProviderErrorCodeV2;
  }
  return "BROWSER_PROVIDER_ERROR";
}

function staleFreshness(reason: string): BrowserFreshnessV2 {
  return { state: "stale", observedAt: Date.now(), reason };
}

function errorFromResponse(response: FirefoxBrokerResponse): BrowserProviderErrorV2 {
  const code = errorCode(response.error?.code);
  const reason = response.error?.reason;
  return {
    code,
    message: response.error?.message || reason || "Firefox provider request failed",
    ...(reason ? { reason } : {}),
    ...(code === "STALE_ELEMENT_REF" ? { freshness: staleFreshness(reason || "stale_ref") } : {}),
  };
}

function errorFromRawMutation(raw: RawMutationResult): BrowserProviderErrorV2 {
  const reason = typeof raw.error?.reason === "string" ? raw.error.reason : undefined;
  const code = errorCode(raw.error?.code);
  return {
    code,
    message: typeof raw.error?.message === "string" ? raw.error.message : reason || "Firefox browser mutation did not start",
    ...(reason ? { reason } : {}),
    ...(code === "STALE_ELEMENT_REF" ? { freshness: staleFreshness(reason || "stale_ref") } : {}),
  };
}

function assertOk(response: FirefoxBrokerResponse): unknown {
  if (!response.ok) {
    const error = errorFromResponse(response);
    throw Object.assign(new Error(error.message), error);
  }
  return response.result;
}

function brokerOptions(
  options: BrowserOperationOptionsV2,
  audienceId: string,
  id?: string,
): { id?: string; signal?: AbortSignal; audienceId: string } {
  return {
    audienceId,
    ...(id === undefined ? {} : { id }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function actionParams(action: BrowserActionV2): Record<string, unknown> {
  if (action.capability === "action.click") return { action: "click", ref: action.ref };
  if (action.capability === "action.fill") return { action: "fill", ref: action.ref, value: action.value };
  if (action.capability === "action.type") return { action: "type", ref: action.ref, text: action.text };
  return { action: "key", ref: action.ref, key: action.key };
}

function actionCapabilities(availability: RawContextAvailability | undefined): BrowserContextCapabilitiesV2 {
  const reason = stringOrEmpty(availability?.reason) || "context_unavailable";
  const snapshotReady = availability?.inspect === true;
  const actReady = availability?.act === true;
  const actionIds: BrowserActionCapabilityIdV2[] = ["action.click", "action.fill", "action.type", "action.key"];
  return {
    snapshot: snapshotReady ? { state: "ready" } : { state: "unavailable", reason },
    actions: Object.fromEntries(
      actionIds.map((id) => [id, actReady ? { state: "ready" } : { state: "unavailable", reason }]),
    ) as BrowserContextCapabilitiesV2["actions"],
  };
}

function documentProvenance(raw: RawSnapshotResult): BrowserDocumentProvenanceV2 {
  const identity = raw.document_identity;
  return {
    documentId: stringOrEmpty(raw.document_id),
    identitySource: identity === "browser-native"
      ? "browser-native"
      : identity === "content-epoch"
        ? "provider-epoch"
        : "unknown",
  };
}

function targetProvenance(
  raw: RawSnapshotResult,
  browserInstanceId: string,
  providerSessionId: string,
  contextId: string,
): BrowserTargetProvenanceV2 {
  return {
    browserInstanceId,
    providerSessionId,
    contextId,
    frame: { frameId: "0", isTop: true, parentFrameId: null },
    document: documentProvenance(raw),
  };
}


const CONTROL_STATES = new Set<BrowserControlStateNameV1>(["no_access", "shared_idle", "agent_claimed", "user_control", "rebinding"]);
const AUTH_STATES = new Set<BrowserAuthorizationStateV1>(["granted", "revoked", "expired", "rebind_required", "protocol_mismatch", "disconnected"]);
const AUTH_ACTIONS = new Set<BrowserAuthorizationActionV1>(["inspect", "interact", "capture", "reorganize", "create_tab", "close_owned_tab"]);
const MUTATION_STATUS_STATES = new Set<BrowserMutationStatusStateV1>(["in_flight", "completed", "outcome_unknown", "not_found", "outside_replay_horizon"]);
const READ_RETRY = { attempts: 3, backoffMs: 150 } as const;

function controlStateFrom(raw: RawControlSummary | undefined): BrowserControlStateV1 {
  const state = typeof raw?.state === "string" && CONTROL_STATES.has(raw.state as BrowserControlStateNameV1)
    ? raw.state as BrowserControlStateNameV1
    : "no_access";
  return {
    state,
    claimGeneration: typeof raw?.claim_generation === "number" ? raw.claim_generation : 0,
    claimedContextId: nullableString(raw?.claimed_context_id),
    claimedByYou: raw?.claimed_by_you === true,
    reason: nullableString(raw?.reason),
    resumeRequested: raw?.resume_requested === true,
  };
}

/** Map a companion/broker failure onto the closed control error taxonomy. Reasons are companion-authored, never page text. */
export function controlErrorFrom(code: unknown, reason: unknown, message: unknown): BrowserControlErrorV1 {
  const r = typeof reason === "string" ? reason : undefined;
  const text = typeof message === "string" && message ? message : r || "Firefox control request failed";
  const make = (mapped: BrowserControlErrorCodeV1): BrowserControlErrorV1 => ({ code: mapped, message: text, ...(r ? { reason: r } : {}) });
  switch (code) {
    case "BROWSER_AUTHORIZATION_REQUIRED":
      switch (r) {
        case "private_window_denied": return make("PRIVATE_WINDOW_DENIED");
        case "restricted_or_unsupported_page": return make("RESTRICTED_PAGE");
        case "rebind_required": return make("REBIND_REQUIRED");
        case "claim_required": return make("CLAIM_REQUIRED");
        case "user_control": return make("USER_CONTROL_ACTIVE");
        case "claimed_by_other_consumer": return make("CLAIM_CHANGED");
        case "authorization_expired": return make("AUTHORIZATION_EXPIRED");
        case "user_revoked": return make("AUTHORIZATION_REVOKED");
        case "outside_scope":
        case "action_outside_scope":
        case "left_authorized_group":
        case "partition_changed":
        case "origin_changed_confirmation_required":
          return make("OUTSIDE_SCOPE");
        default:
          return r?.endsWith("_not_granted") ? make("OUTSIDE_SCOPE") : make("AUTHORIZATION_REQUIRED");
      }
    case "STALE_ELEMENT_REF":
      return make(r === "claim_changed" || r === "claim_context_changed" ? "CLAIM_CHANGED" : "STALE_OBSERVATION");
    case "BROWSER_CONTEXT_GONE":
    case "BROWSER_CONTEXT_NOT_FOUND":
      return make("CONTEXT_GONE");
    case "BROWSER_CONTEXT_UNAVAILABLE":
      return make(r === "claimed_tab_not_focused" ? "FOCUS_CHANGED" : r === "no_normal_window_available" ? "RESTRICTED_PAGE" : "RESTRICTED_PAGE");
    case "BROWSER_PROTOCOL_MISMATCH":
      return make("PROTOCOL_MISMATCH");
    case "COMPANION_NOT_READY":
      return make("COMPANION_NOT_READY");
    case "REQUEST_ID_CONFLICT":
      return make("REQUEST_ID_CONFLICT");
    case "REPLAY_HORIZON_EXPIRED":
      return make("REPLAY_HORIZON_EXPIRED");
    case "MUTATION_OUTCOME_UNKNOWN":
    case "BROWSER_ACTION_RESPONSE_LOST":
    case "BROKER_RESPONSE_TIMEOUT":
    case "BROKER_EXITED":
      return make("OUTCOME_UNKNOWN");
    case "CONTEXT_NOT_OWNED":
      return make("OUTSIDE_SCOPE");
    case "UNSUPPORTED_OPERATION":
    case "UNSUPPORTED_CAPABILITY":
      return make("UNSUPPORTED_CAPABILITY");
    case "RESOURCE_BUSY":
      return make("RESOURCE_BUSY");
    case "ARTIFACT_EXPIRED":
    case "ARTIFACT_SIZE_LIMIT":
    case "ARTIFACT_INTEGRITY_MISMATCH":
    case "ARTIFACT_NOT_FOUND":
      return make(code);
    case "BROWSER_DOCUMENT_CHANGED":
      return make("STALE_OBSERVATION");
    case "INVALID_ARGUMENT":
      return make("INVALID_ARGUMENT");
    default:
      return make("PROVIDER_ERROR");
  }
}

function authorizationStateFrom(raw: RawAuthorizationStatus | undefined): BrowserAuthorizationStateV1 {
  if (raw?.protocol_compatible === false) return "protocol_mismatch";
  const state = raw?.state;
  return typeof state === "string" && AUTH_STATES.has(state as BrowserAuthorizationStateV1)
    ? state as BrowserAuthorizationStateV1
    : "revoked";
}

function noAccessControl(): BrowserControlStateV1 {
  return { state: "no_access", claimGeneration: 0, claimedContextId: null, claimedByYou: false, reason: null, resumeRequested: false };
}

function ownershipFor(raw: unknown): BrowserContextSummaryV2["ownership"] {
  return raw === "provider-owned"
    ? { owner: "provider", lifecycle: "provider-managed" }
    : { owner: "user", lifecycle: "preserve" };
}

export class FirefoxBrowserProviderV2 implements
  BrowserProviderV2,
  BrowserAuthorizationProviderV1,
  BrowserControlProviderV1,
  BrowserTabProviderV1,
  BrowserTabGroupProviderV1,
  BrowserArtifactProviderV1 {
  readonly tabGroupProtocolVersion = BROWSER_TAB_GROUP_PROVIDER_V1;
  readonly artifactProtocolVersion = BROWSER_ARTIFACT_PROVIDER_V1;
  readonly authorizationProtocolVersion = BROWSER_AUTHORIZATION_PROVIDER_V1;
  readonly controlProtocolVersion = BROWSER_CONTROL_PROVIDER_V1;
  readonly tabProtocolVersion = BROWSER_TAB_PROVIDER_V1;
  readonly protocolVersion = BROWSER_PROVIDER_V2;
  readonly #browserInstanceId: string | undefined;
  readonly #sessionMaxAgeMs: number | undefined;
  readonly #sessionsDir: string | undefined;
  readonly #audienceId: string;
  readonly #clientLabel: string | undefined;
  readonly #artifactOptions: { root?: string; lifetimeMs?: number };
  #artifacts: ArtifactStore | undefined;
  readonly #trackedRefs = new Map<string, TrackedRef>();

  constructor(options: FirefoxBrowserProviderOptions = {}) {
    this.#browserInstanceId = options.browserInstanceId;
    this.#sessionMaxAgeMs = options.sessionMaxAgeMs;
    this.#sessionsDir = options.sessionsDir;
    this.#audienceId = normalizeAudienceId(options.audienceId || options.clientId);
    this.#clientLabel = options.clientLabel;
    this.#artifactOptions = {
      ...(options.artifactRoot !== undefined ? { root: options.artifactRoot } : {}),
      ...(options.artifactLifetimeMs !== undefined ? { lifetimeMs: options.artifactLifetimeMs } : {}),
    };
  }

  #artifactStore(): ArtifactStore {
    this.#artifacts ??= new ArtifactStore({ ...this.#artifactOptions, audienceId: this.#audienceId });
    return this.#artifacts;
  }

  async declaration(): Promise<BrowserProviderDeclarationV2> {
    return DECLARATION;
  }

  #sessions(): FirefoxSessionReceipt[] {
    return listLiveFirefoxSessions({
      ...(this.#sessionMaxAgeMs === undefined ? {} : { maxAgeMs: this.#sessionMaxAgeMs }),
      ...(this.#sessionsDir === undefined ? {} : { sessionsDir: this.#sessionsDir }),
    });
  }

  #sessionFor(browserInstanceId?: string): FirefoxSessionReceipt {
    const requested = browserInstanceId ?? this.#browserInstanceId;
    const sessions = this.#sessions();
    if (!requested) return selectFirefoxSession(sessions);
    return selectFirefoxSession(sessions.filter((session) => session.browser_instance_id === requested));
  }

  #sessionMatches(session: FirefoxSessionReceipt, requestedSessionId?: string): boolean {
    return requestedSessionId === undefined || requestedSessionId === session.session_id;
  }

  #trackRef(ref: string, observation: TrackedRef): void {
    if (!ref) return;
    if (this.#trackedRefs.size >= MAX_TRACKED_REFS) {
      const first = this.#trackedRefs.keys().next().value as string | undefined;
      if (first !== undefined) this.#trackedRefs.delete(first);
    }
    this.#trackedRefs.set(ref, observation);
  }

  async #rawStatus(session: FirefoxSessionReceipt, options: BrowserOperationOptionsV2): Promise<RawStatus> {
    const response = await sendFirefoxBrokerRequest(
      session,
      "status",
      this.#clientLabel ? { client_label: this.#clientLabel } : {},
      { ...brokerOptions(options, this.#audienceId), readRetry: READ_RETRY },
    );
    return assertOk(response) as RawStatus;
  }

  async status(options: BrowserOperationOptionsV2 = {}): Promise<BrowserProviderStatusV2> {
    const session = this.#sessionFor();
    const raw = await this.#rawStatus(session, options);
    const auth = raw.authorization ?? {};
    return {
      protocolVersion: BROWSER_PROVIDER_V2,
      providerId: PROVIDER_ID,
      providerSessionId: session.session_id,
      authorization: {
        state: auth.state === "granted" ? "granted" : "revoked",
        currentBindingId: nullableString(auth.current_host_session_id),
        grantedBindingId: nullableString(auth.granted_host_session_id),
        grantedAt: nullableNumber(auth.granted_at),
      },
    };
  }

  async listInstances(): Promise<readonly import("@zamery/browser-provider").BrowserInstanceSummaryV2[]> {
    const byId = new Map<string, import("@zamery/browser-provider").BrowserInstanceSummaryV2>();
    for (const session of this.#sessions()) {
      const browserInstanceId = nullableString(session.browser_instance_id);
      if (!browserInstanceId) continue;
      byId.set(browserInstanceId, {
        browserInstanceId,
        providerSessionId: session.session_id,
        ...(session.profile_id ? { profileId: session.profile_id } : {}),
        ownership: { owner: "user", lifecycle: "preserve" },
      });
    }
    return [...byId.values()];
  }

  async listContexts(
    request: { browserInstanceId: string; providerSessionId?: string },
    options: BrowserOperationOptionsV2 = {},
  ): Promise<readonly BrowserContextSummaryV2[]> {
    const session = this.#sessionFor(request.browserInstanceId);
    if (!this.#sessionMatches(session, request.providerSessionId)) {
      throw Object.assign(new Error("Firefox provider session changed"), { code: "PROVIDER_SESSION_CHANGED" });
    }
    const response = await sendFirefoxBrokerRequest(session, "list_contexts", {}, { ...brokerOptions(options, this.#audienceId), readRetry: READ_RETRY });
    const raw = assertOk(response) as RawContextsResult;
    const browserInstanceId = stringOrEmpty(raw.browser_instance_id) || request.browserInstanceId;
    const contexts = Array.isArray(raw.contexts) ? raw.contexts as RawContext[] : [];
    return contexts.map((context) => ({
      browserInstanceId,
      providerSessionId: session.session_id,
      contextId: stringOrEmpty(context.context_id),
      ownership: ownershipFor(context.ownership),
      title: stringOrEmpty(context.title),
      url: stringOrEmpty(context.url),
      active: context.active === true,
      capabilities: actionCapabilities(context.availability),
    }));
  }

  async snapshot(
    request: { browserInstanceId: string; providerSessionId?: string; contextId: string },
    options: BrowserOperationOptionsV2 = {},
  ): Promise<BrowserSnapshotV2> {
    const session = this.#sessionFor(request.browserInstanceId);
    if (!this.#sessionMatches(session, request.providerSessionId)) {
      throw Object.assign(new Error("Firefox provider session changed"), { code: "PROVIDER_SESSION_CHANGED" });
    }
    const response = await sendFirefoxBrokerRequest(
      session,
      "snapshot",
      { context_id: request.contextId },
      { ...brokerOptions(options, this.#audienceId), readRetry: READ_RETRY },
    );
    const raw = assertOk(response) as RawSnapshotResult;
    const contextId = stringOrEmpty(raw.context_id) || request.contextId;
    const observationId = stringOrEmpty(raw.snapshot_id);
    const target = targetProvenance(raw, request.browserInstanceId, session.session_id, contextId);
    const freshness: BrowserFreshnessV2 = {
      state: "fresh",
      observedAt: Date.now(),
      basis: "provider-observed",
    };
    const nodes = Array.isArray(raw.nodes) ? raw.nodes as RawSnapshotNode[] : [];
    const mappedNodes = nodes.map((node) => {
      const ref = stringOrEmpty(node.ref);
      this.#trackRef(ref, { observationId, target });
      return {
        ref,
        target,
        freshness,
        ...(typeof node.role === "string" ? { role: node.role } : {}),
        ...(typeof node.name === "string" ? { name: node.name } : {}),
        ...(typeof node.tag === "string" ? { tag: node.tag } : {}),
        ...(typeof node.value === "string" ? { value: node.value } : {}),
        ...(typeof node.contenteditable === "boolean" ? { contenteditable: node.contenteditable } : {}),
        ...(typeof node.type === "string" ? { inputType: node.type } : {}),
        ...(typeof node.checked === "boolean" ? { checked: node.checked } : {}),
        ...(node.disabled === true ? { disabled: true } : {}),
        ...(node.credential === true ? { credential: true } : {}),
      };
    });
    return {
      browserInstanceId: request.browserInstanceId,
      providerSessionId: session.session_id,
      contextId,
      observationId,
      url: stringOrEmpty(raw.url),
      title: stringOrEmpty(raw.title),
      target,
      freshness,
      ...(raw.coverage
        ? {
            coverage: {
              truncated: raw.coverage.truncated === true,
              ...(typeof raw.coverage.node_limit === "number" ? { nodeLimit: raw.coverage.node_limit } : {}),
              valuesExported: raw.coverage.values_exported === true,
              hiddenControlsExcluded: raw.coverage.hidden_controls_excluded !== false,
            },
          }
        : {}),
      nodes: mappedNodes,
    };
  }

  async act(
    request: BrowserMutationRequestV2,
    options: BrowserOperationOptionsV2 = {},
  ): Promise<BrowserMutationResultV2> {
    const session = this.#sessionFor(request.browserInstanceId);
    if (!this.#sessionMatches(session, request.providerSessionId)) {
      return {
        outcome: "not_started",
        error: {
          code: "PROVIDER_SESSION_CHANGED",
          message: `Firefox provider session changed from ${request.providerSessionId} to ${session.session_id}`,
        },
        replayed: false,
      };
    }

    const tracked = this.#trackedRefs.get(request.action.ref);
    if (!tracked || tracked.observationId !== request.action.observationId) {
      return {
        outcome: "not_started",
        error: {
          code: "STALE_ELEMENT_REF",
          message: "element ref does not belong to the supplied observation",
          reason: "observation_changed",
          freshness: staleFreshness("observation_changed"),
        },
        replayed: false,
      };
    }
    if (
      tracked.target.browserInstanceId !== request.browserInstanceId
      || tracked.target.providerSessionId !== request.providerSessionId
      || tracked.target.contextId !== request.contextId
    ) {
      return {
        outcome: "not_started",
        error: {
          code: "STALE_ELEMENT_REF",
          message: "element ref target identity changed",
          reason: "target_changed",
          freshness: staleFreshness("target_changed"),
        },
        replayed: false,
      };
    }

    let response: FirefoxBrokerResponse;
    try {
      response = await sendFirefoxBrokerRequest(
        session,
        "act",
        { context_id: request.contextId, ...actionParams(request.action) },
        brokerOptions(options, this.#audienceId, request.requestId),
      );
    } catch (error) {
      if (!isFirefoxBrokerTransportError(error)) throw error;
      // A lost response after dispatch is not a retryable error: the action may already have run.
      return error.phase === "not_dispatched"
        ? { outcome: "not_started", error: { code: "BROWSER_PROVIDER_ERROR", message: error.message, reason: "transport_not_dispatched" }, replayed: false }
        : { outcome: "outcome_unknown", error: { code: "MUTATION_OUTCOME_UNKNOWN", message: error.message, reason: "transport_dispatch_unknown" }, replayed: false };
    }
    if (!response.ok) {
      const outcome = response.outcome ?? "not_started";
      const error = errorFromResponse(response);
      if (outcome === "partially_applied" || outcome === "outcome_unknown") {
        return { outcome, error, replayed: response.replayed === true };
      }
      return {
        outcome: "not_started",
        error,
        ...(error.code === "BROWSER_REQUEST_CANCELLED"
          ? { cancellation: { requested: true as const, effect: "prevented_before_start" as const } }
          : {}),
        replayed: response.replayed === true,
      };
    }

    const raw = response.result as RawMutationResult;
    if (raw?.outcome === "not_started") {
      const error = errorFromRawMutation(raw);
      return {
        outcome: "not_started",
        error,
        ...(error.code === "BROWSER_REQUEST_CANCELLED"
          ? { cancellation: { requested: true as const, effect: "prevented_before_start" as const } }
          : {}),
        replayed: response.replayed === true,
      };
    }
    if (raw?.outcome === "partially_applied" || raw?.outcome === "outcome_unknown") {
      return {
        outcome: raw.outcome,
        error: errorFromRawMutation(raw),
        replayed: response.replayed === true,
      };
    }
    if (raw?.outcome !== "completed") {
      return {
        outcome: "outcome_unknown",
        error: {
          code: "BROWSER_PROVIDER_ERROR",
          message: `Firefox provider returned unexpected mutation outcome: ${String(raw?.outcome)}`,
        },
        replayed: response.replayed === true,
      };
    }

    const observedAt = Date.now();
    const receipt = {
      receiptKind: "browser-action" as const,
      schemaVersion: BROWSER_PROVIDER_V2_RECEIPT_SCHEMA,
      protocolVersion: BROWSER_PROVIDER_V2,
      providerId: PROVIDER_ID,
      providerSessionId: session.session_id,
      requestId: request.requestId,
      action: request.action.capability,
      declaredSemantics: ACTION_SEMANTICS[request.action.capability],
      observed: {
        schemaVersion: BROWSER_PROVIDER_V2_RECEIPT_SCHEMA,
        observedAt,
        targetValidation: {
          state: "fresh" as const,
          observedAt,
          basis: "action-time-validated" as const,
        },
        domEventTrust: typeof raw.result?.observed_is_trusted === "boolean"
          ? { observed: true as const, isTrusted: raw.result.observed_is_trusted }
          : { observed: false as const },
        documentBefore: tracked.target.document,
        providerEvidence: [{
          namespace: "firefox",
          semanticId: "firefox/dom-synthetic-action-observation",
          version: 1,
          fields: {
            mechanism: stringOrEmpty(raw.result?.mechanism) || "dom-synthetic",
            ...(typeof raw.result?.user_activation_before === "boolean"
              ? { userActivationBefore: raw.result.user_activation_before }
              : {}),
            ...(typeof raw.result?.user_activation_after === "boolean"
              ? { userActivationAfter: raw.result.user_activation_after }
              : {}),
          },
        }],
      },
    };
    validateBrowserActionReceiptV2(receipt);

    const cancellation = raw.cancellation?.requested === true
      ? { requested: true as const, effect: "none_after_start" as const }
      : { requested: false as const };
    return {
      outcome: "completed",
      receipt,
      cancellation,
      replayed: response.replayed === true,
    };
  }


  // ---- BrowserAuthorizationProviderV1 ------------------------------------------------------------------

  async authorizationDetail(
    request: Partial<BrowserControlTargetV1> = {},
    options: BrowserOperationOptionsV2 = {},
  ): Promise<BrowserAuthorizationDetailV1> {
    let session: FirefoxSessionReceipt;
    try {
      session = this.#sessionFor(request.browserInstanceId);
    } catch (error) {
      if (error instanceof FirefoxSessionSelectionError) {
        return {
          protocolVersion: BROWSER_AUTHORIZATION_PROVIDER_V1,
          state: "disconnected",
          reason: error.code === "BROWSER_INSTANCE_AMBIGUOUS" ? "multiple_browser_sessions" : "no_browser_session",
          grantRevision: 0,
          grantId: null,
          bindingToken: null,
          mode: null,
          durationDays: null,
          issuedAt: null,
          expiresAt: null,
          scope: { kind: null, count: 0 },
          actions: [],
          groupPolicy: null,
          restartPolicy: "explicit_rebind",
          protocolCompatible: true,
          control: noAccessControl(),
        };
      }
      throw error;
    }
    const raw = await this.#rawStatus(session, options);
    const auth = raw.authorization ?? {};
    const actions = Array.isArray(auth.actions)
      ? auth.actions.filter((value): value is BrowserAuthorizationActionV1 => typeof value === "string" && AUTH_ACTIONS.has(value as BrowserAuthorizationActionV1))
      : [];
    const features: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw.features ?? {})) if (typeof value === "boolean") features[key] = value;
    return {
      protocolVersion: BROWSER_AUTHORIZATION_PROVIDER_V1,
      state: authorizationStateFrom(auth),
      reason: nullableString(auth.reason),
      grantRevision: typeof auth.grant_revision === "number" ? auth.grant_revision : 0,
      grantId: nullableString(auth.grant_id),
      bindingToken: nullableString(auth.binding_token),
      mode: auth.duration_mode === "session" || auth.duration_mode === "fixed" ? auth.duration_mode : null,
      durationDays: nullableNumber(auth.duration_days),
      issuedAt: nullableNumber(auth.granted_at),
      expiresAt: nullableNumber(auth.expires_at),
      scope: {
        kind: auth.scope_kind === "tabs" || auth.scope_kind === "group" ? auth.scope_kind : null,
        count: typeof auth.scope_count === "number" ? auth.scope_count : 0,
      },
      actions,
      groupPolicy: auth.group_policy === "membership_snapshot" || auth.group_policy === "follow_group" ? auth.group_policy : null,
      restartPolicy: "explicit_rebind",
      protocolCompatible: auth.protocol_compatible !== false,
      control: controlStateFrom(auth.control),
      companion: { version: nullableString(raw.companion_extension_version), featureFlags: features },
    };
  }

  // ---- control plumbing ------------------------------------------------------------------------------------

  #controlSession(target: BrowserControlTargetV1): FirefoxSessionReceipt {
    const session = this.#sessionFor(target.browserInstanceId);
    if (!this.#sessionMatches(session, target.providerSessionId)) {
      throw Object.assign(new Error("Firefox provider session changed"), { code: "PROVIDER_SESSION_CHANGED" });
    }
    return session;
  }

  #receipt(
    session: FirefoxSessionReceipt,
    requestId: string,
    operation: string,
    outcome: BrowserMutationOutcomeV2,
    extra: { completedSubsteps?: readonly string[]; contextIds?: readonly string[]; focusedContextId?: string } = {},
  ): BrowserControlReceiptV1 {
    return {
      receiptKind: "browser-control",
      schemaVersion: BROWSER_CONTROL_RECEIPT_SCHEMA_V1,
      protocolVersion: BROWSER_CONTROL_PROVIDER_V1,
      providerId: PROVIDER_ID,
      providerSessionId: session.session_id,
      requestId,
      operation,
      outcome,
      completedSubsteps: extra.completedSubsteps ?? [],
      observedAt: Date.now(),
      ...(extra.contextIds ? { contextIds: extra.contextIds } : {}),
      ...(extra.focusedContextId ? { focusedContextId: extra.focusedContextId } : {}),
    };
  }

  /**
   * Run one durable control mutation. Transport loss after dispatch is `outcome_unknown`; it is never retried here.
   * Reconciliation goes through mutationStatus with the same requestId.
   */
  async #controlMutation<T>(
    target: BrowserControlTargetV1,
    request: { requestId: string; operation: string; op: string; params: Record<string, unknown> },
    options: BrowserOperationOptionsV2,
    buildValue: (result: Record<string, unknown>) => T,
  ): Promise<BrowserControlResultV1<T>> {
    let session: FirefoxSessionReceipt;
    try {
      session = this.#controlSession(target);
    } catch (error) {
      const code = (error as { code?: string }).code;
      return {
        outcome: "not_started",
        error: {
          code: code === "BROWSER_INSTANCE_NOT_FOUND" ? "HOST_MISSING" : code === "PROVIDER_SESSION_CHANGED" ? "TRANSPORT_DISCONNECTED" : "PROVIDER_ERROR",
          message: (error as Error).message,
          ...(code ? { reason: code.toLowerCase() } : {}),
        },
        replayed: false,
      };
    }
    let response: FirefoxBrokerResponse;
    try {
      response = await sendFirefoxBrokerRequest(
        session,
        request.op,
        request.params,
        brokerOptions(options, this.#audienceId, request.requestId),
      );
    } catch (error) {
      if (!isFirefoxBrokerTransportError(error)) throw error;
      return error.phase === "not_dispatched"
        ? { outcome: "not_started", error: { code: "TRANSPORT_DISCONNECTED", message: error.message, reason: "transport_not_dispatched" }, replayed: false }
        : { outcome: "outcome_unknown", error: { code: "OUTCOME_UNKNOWN", message: error.message, reason: "transport_dispatch_unknown" }, replayed: false };
    }
    const replayed = response.replayed === true;
    if (!response.ok) {
      const error = controlErrorFrom(response.error?.code, response.error?.reason, response.error?.message);
      const outcome = response.outcome ?? "not_started";
      if (outcome === "partially_applied" || outcome === "outcome_unknown") {
        return { outcome, error, replayed };
      }
      return { outcome: "not_started", error, replayed };
    }
    const result = (response.result && typeof response.result === "object" ? response.result : {}) as Record<string, unknown>;
    if (result.outcome === "not_started") {
      const raw = (result.error ?? {}) as { code?: unknown; reason?: unknown; message?: unknown };
      return { outcome: "not_started", error: controlErrorFrom(raw.code, raw.reason, raw.message), replayed };
    }
    if (result.outcome === "partially_applied" || result.outcome === "outcome_unknown") {
      const raw = (result.error ?? {}) as { code?: unknown; reason?: unknown; message?: unknown };
      return {
        outcome: result.outcome,
        error: controlErrorFrom(raw.code, raw.reason, raw.message),
        receipt: this.#receipt(session, request.requestId, request.operation, result.outcome, {
          completedSubsteps: stringList(result.completed_substeps),
        }),
        replayed,
      };
    }
    if (result.outcome !== undefined && result.outcome !== "completed") {
      return {
        outcome: "outcome_unknown",
        error: { code: "PROVIDER_ERROR", message: `Firefox provider returned unexpected outcome: ${String(result.outcome)}` },
        replayed,
      };
    }
    const contextIds = stringList(result.member_context_ids);
    const focused = typeof result.focused_context_id === "string" ? result.focused_context_id : undefined;
    return {
      outcome: "completed",
      receipt: this.#receipt(session, request.requestId, request.operation, "completed", {
        completedSubsteps: stringList(result.completed_substeps),
        ...(contextIds.length > 0 ? { contextIds } : {}),
        ...(focused ? { focusedContextId: focused } : {}),
      }),
      value: buildValue(result),
      replayed,
    };
  }

  // ---- BrowserControlProviderV1 ----------------------------------------------------------------------------

  async #controlRead(
    target: BrowserControlTargetV1,
    op: string,
    params: Record<string, unknown>,
    options: BrowserOperationOptionsV2,
  ): Promise<Record<string, unknown>> {
    const session = this.#controlSession(target);
    const response = await sendFirefoxBrokerRequest(
      session,
      op,
      params,
      { ...brokerOptions(options, this.#audienceId), readRetry: READ_RETRY },
    );
    return (assertOk(response) ?? {}) as Record<string, unknown>;
  }

  async controlState(request: BrowserControlTargetV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlStateV1> {
    const session = this.#controlSession(request);
    const raw = await this.#rawStatus(session, options);
    return controlStateFrom(raw.authorization?.control);
  }

  async claim(request: BrowserClaimRequestV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlResultV1<BrowserClaimValueV1>> {
    // A claim is itself a (non-durable) state change; it carries a fresh id so a retry is a new claim.
    const requestId = createFirefoxRequestId();
    return this.#controlMutationNonDurable(request, requestId, "control.claim", "control_claim", { context_id: request.contextId }, options, (result) => ({
      contextId: stringOrEmpty(result.context_id) || request.contextId,
      claimGeneration: typeof result.claim_generation === "number" ? result.claim_generation : 0,
    }));
  }

  /** Claims are session state, not journaled mutations: a lost response is simply re-read via controlState. */
  async #controlMutationNonDurable<T>(
    target: BrowserControlTargetV1,
    requestId: string,
    operation: string,
    op: string,
    params: Record<string, unknown>,
    options: BrowserOperationOptionsV2,
    buildValue: (result: Record<string, unknown>) => T,
  ): Promise<BrowserControlResultV1<T>> {
    let session: FirefoxSessionReceipt;
    try {
      session = this.#controlSession(target);
    } catch (error) {
      return { outcome: "not_started", error: { code: "HOST_MISSING", message: (error as Error).message }, replayed: false };
    }
    let response: FirefoxBrokerResponse;
    try {
      response = await sendFirefoxBrokerRequest(session, op, params, brokerOptions(options, this.#audienceId, requestId));
    } catch (error) {
      if (!isFirefoxBrokerTransportError(error)) throw error;
      return { outcome: "not_started", error: { code: "TRANSPORT_DISCONNECTED", message: error.message, reason: error.phase }, replayed: false };
    }
    if (!response.ok) {
      return { outcome: "not_started", error: controlErrorFrom(response.error?.code, response.error?.reason, response.error?.message), replayed: false };
    }
    const result = (response.result && typeof response.result === "object" ? response.result : {}) as Record<string, unknown>;
    return {
      outcome: "completed",
      receipt: this.#receipt(session, requestId, operation, "completed"),
      value: buildValue(result),
      replayed: response.replayed === true,
    };
  }

  async release(request: BrowserControlTargetV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlStateV1> {
    await this.#controlRead(request, "control_release", {}, options);
    return this.controlState(request, options);
  }

  async requestUserTakeover(
    request: BrowserControlTargetV1 & { note?: string },
    options: BrowserOperationOptionsV2 = {},
  ): Promise<BrowserControlStateV1> {
    await this.#controlRead(request, "control_takeover", request.note ? { note: request.note } : {}, options);
    return this.controlState(request, options);
  }

  async requestResume(request: BrowserControlTargetV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlStateV1> {
    await this.#controlRead(request, "control_request_resume", {}, options);
    return this.controlState(request, options);
  }

  async mutationStatus(
    request: BrowserControlTargetV1 & { requestId: string },
    options: BrowserOperationOptionsV2 = {},
  ): Promise<BrowserMutationStatusV1> {
    const raw = await this.#controlRead(request, "mutation_status", { request_id: request.requestId }, options) as RawMutationStatus;
    const state = typeof raw.state === "string" && MUTATION_STATUS_STATES.has(raw.state as BrowserMutationStatusStateV1)
      ? raw.state as BrowserMutationStatusStateV1
      : "not_found";
    const outcome = raw.outcome === "completed" || raw.outcome === "not_started" || raw.outcome === "partially_applied" || raw.outcome === "outcome_unknown"
      ? raw.outcome
      : undefined;
    return {
      requestId: request.requestId,
      state,
      ...(outcome ? { outcome } : {}),
      ...(typeof raw.op === "string" ? { operation: raw.op } : {}),
      ...(typeof raw.started_at === "number" ? { startedAt: raw.started_at } : {}),
      ...(typeof raw.completed_at === "number" ? { completedAt: raw.completed_at } : {}),
      replayHorizonMs: typeof raw.replay_horizon_ms === "number" ? raw.replay_horizon_ms : 0,
    };
  }

  // ---- BrowserTabProviderV1 --------------------------------------------------------------------------------

  async tabCapabilities(request: BrowserControlTargetV1, options: BrowserOperationOptionsV2 = {}): Promise<readonly BrowserTabCapabilityIdV1[]> {
    const detail = await this.authorizationDetail(request, options);
    if (detail.state !== "granted") return [];
    const ids: BrowserTabCapabilityIdV1[] = [];
    if (detail.actions.includes("create_tab")) ids.push("tab.create");
    if (detail.actions.includes("create_tab")) ids.push("tab.navigate", "tab.reload");
    if (detail.actions.includes("interact")) ids.push("tab.activate");
    if (detail.actions.includes("close_owned_tab")) ids.push("tab.close-owned");
    return BROWSER_TAB_PROVIDER_V1_CAPABILITIES.filter((id) => ids.includes(id));
  }

  #tabValue(result: Record<string, unknown>, fallbackContextId = ""): BrowserTabValueV1 {
    return {
      contextId: stringOrEmpty(result.context_id) || fallbackContextId,
      ownership: result.ownership === "provider-owned" ? "provider-owned" : "user-owned",
    };
  }

  createTab(request: BrowserTabCreateRequestV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlResultV1<BrowserTabValueV1>> {
    return this.#controlMutation(request, {
      requestId: request.requestId,
      operation: "tab.create",
      op: "create_tab",
      params: { url: request.url, active: request.active === true },
    }, options, (result) => this.#tabValue(result));
  }

  navigateTab(request: BrowserTabNavigateRequestV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlResultV1<BrowserTabValueV1>> {
    return this.#controlMutation(request, {
      requestId: request.requestId,
      operation: "tab.navigate",
      op: "navigate_tab",
      params: { context_id: request.contextId, url: request.url },
    }, options, (result) => this.#tabValue(result, request.contextId));
  }

  reloadTab(request: BrowserTabContextRequestV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlResultV1<BrowserTabValueV1>> {
    return this.#controlMutation(request, {
      requestId: request.requestId,
      operation: "tab.reload",
      op: "reload_tab",
      params: { context_id: request.contextId },
    }, options, (result) => this.#tabValue(result, request.contextId));
  }

  activateTab(request: BrowserTabContextRequestV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlResultV1<BrowserTabValueV1>> {
    return this.#controlMutation(request, {
      requestId: request.requestId,
      operation: "tab.activate",
      op: "activate_tab",
      params: { context_id: request.contextId },
    }, options, (result) => this.#tabValue(result, request.contextId));
  }

  closeOwnedTab(request: BrowserTabContextRequestV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlResultV1<undefined>> {
    return this.#controlMutation(request, {
      requestId: request.requestId,
      operation: "tab.close-owned",
      op: "close_owned_tab",
      params: { context_id: request.contextId },
    }, options, () => undefined);
  }


  // ---- BrowserTabGroupProviderV1 ---------------------------------------------------------------------------

  async listTabGroups(request: BrowserControlTargetV1, options: BrowserOperationOptionsV2 = {}): Promise<readonly BrowserTabGroupV1[]> {
    const raw = await this.#controlRead(request, "group_list", {}, options);
    return Array.isArray(raw.groups) ? raw.groups.map(groupFrom) : [];
  }

  async getTabGroup(
    request: BrowserControlTargetV1 & { handle: string },
    options: BrowserOperationOptionsV2 = {},
  ): Promise<BrowserTabGroupV1> {
    const raw = await this.#controlRead(request, "group_get", { handle: request.handle }, options);
    return groupFrom(raw.group);
  }

  createTabGroup(request: BrowserTabGroupCreateRequestV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlResultV1<BrowserTabGroupV1>> {
    return this.#controlMutation(request, {
      requestId: request.requestId,
      operation: "group.create",
      op: "group_create",
      params: { context_ids: [...request.contextIds], ...(request.title !== undefined ? { title: request.title } : {}), ...(request.color ? { color: request.color } : {}) },
    }, options, groupFromResult);
  }

  updateTabGroup(request: BrowserTabGroupUpdateRequestV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlResultV1<BrowserTabGroupV1>> {
    return this.#controlMutation(request, {
      requestId: request.requestId,
      operation: "group.update",
      op: "group_update",
      params: {
        handle: request.handle,
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.color ? { color: request.color } : {}),
        ...(request.collapsed !== undefined ? { collapsed: request.collapsed } : {}),
      },
    }, options, groupFromResult);
  }

  addTabsToGroup(request: BrowserTabGroupMembershipRequestV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlResultV1<BrowserTabGroupV1>> {
    return this.#controlMutation(request, {
      requestId: request.requestId,
      operation: "group.add-tabs",
      op: "group_add_tabs",
      params: { handle: request.handle, context_ids: [...request.contextIds] },
    }, options, groupFromResult);
  }

  removeTabsFromGroup(request: BrowserTabGroupMembershipRequestV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlResultV1<BrowserTabGroupV1 | null>> {
    return this.#controlMutation(request, {
      requestId: request.requestId,
      operation: "group.remove-tabs",
      op: "group_remove_tabs",
      params: { handle: request.handle, context_ids: [...request.contextIds] },
    }, options, (result) => (result.group || result.group_handle ? groupFromResult(result) : null));
  }

  moveTabGroup(request: BrowserTabGroupMoveRequestV1, options: BrowserOperationOptionsV2 = {}): Promise<BrowserControlResultV1<BrowserTabGroupV1>> {
    return this.#controlMutation(request, {
      requestId: request.requestId,
      operation: "group.move",
      op: "group_move",
      params: { handle: request.handle, index: request.index, ...(request.windowId !== undefined ? { window_id: request.windowId } : {}) },
    }, options, groupFromResult);
  }

  activateTabGroup(
    request: BrowserTabGroupMutationBaseV1 & { handle: string; contextId?: string },
    options: BrowserOperationOptionsV2 = {},
  ): Promise<BrowserControlResultV1<BrowserTabGroupActivateValueV1>> {
    return this.#controlMutation(request, {
      requestId: request.requestId,
      operation: "group.activate",
      op: "group_activate",
      params: { handle: request.handle, ...(request.contextId ? { context_id: request.contextId } : {}) },
    }, options, (result) => ({ group: groupFromResult(result), focusedContextId: stringOrEmpty(result.focused_context_id) }));
  }


  // ---- BrowserArtifactProviderV1 ---------------------------------------------------------------------------

  async screenshot(
    request: BrowserScreenshotRequestV1,
    options: BrowserOperationOptionsV2 = {},
  ): Promise<BrowserControlResultV1<BrowserArtifactDescriptorV1>> {
    const failed = (error: BrowserControlErrorV1): BrowserControlResultV1<BrowserArtifactDescriptorV1> => ({ outcome: "not_started", error, replayed: false });
    let session: FirefoxSessionReceipt;
    try {
      session = this.#controlSession(request);
    } catch (error) {
      return failed({ code: "HOST_MISSING", message: (error as Error).message });
    }
    const params: Record<string, unknown> = { context_id: request.contextId };
    if (request.rect) params.rect = { ...request.rect };
    if (request.scale !== undefined) params.scale = request.scale;
    if (request.maxSide !== undefined) params.max_side = request.maxSide;
    if (request.format) params.format = request.format;
    if (request.quality !== undefined) params.quality = request.quality;

    let raw: Record<string, unknown>;
    try {
      const response = await sendFirefoxBrokerRequest(session, "screenshot_capture", params, {
        ...brokerOptions(options, this.#audienceId, request.requestId),
        timeoutMs: 30_000,
      });
      if (!response.ok) return failed(controlErrorFrom(response.error?.code, response.error?.reason, response.error?.message));
      raw = (response.result && typeof response.result === "object" ? response.result : {}) as Record<string, unknown>;
    } catch (error) {
      // A screenshot changes nothing in the browser, so a lost response is simply "not captured".
      if (isFirefoxBrokerTransportError(error)) return failed({ code: "TRANSPORT_DISCONNECTED", message: error.message, reason: error.phase });
      throw error;
    }

    const artifactId = stringOrEmpty(raw.artifact_id);
    const remote = {
      artifactId,
      sha256: stringOrEmpty(raw.sha256),
      byteSize: typeof raw.byte_size === "number" ? raw.byte_size : -1,
      chunk: typeof raw.chunk_raw_bytes === "number" ? raw.chunk_raw_bytes : BROWSER_ARTIFACT_LIMITS_V1.maxChunkRawBytes,
    };
    if (!artifactId || remote.byteSize <= 0 || remote.byteSize > BROWSER_ARTIFACT_LIMITS_V1.maxEncodedBytes || remote.chunk > BROWSER_ARTIFACT_LIMITS_V1.maxChunkRawBytes) {
      return failed({ code: "ARTIFACT_SIZE_LIMIT", message: "the companion returned an out-of-bounds artifact descriptor" });
    }
    const closeRemote = (): void => {
      void sendFirefoxBrokerRequest(session, "artifact_close", { artifact_id: artifactId }, brokerOptions({}, this.#audienceId)).catch(() => undefined);
    };

    const chunks: Buffer[] = [];
    let received = 0;
    try {
      for (let sequence = 0; ; sequence += 1) {
        if (options.signal?.aborted) {
          closeRemote();
          return failed({ code: "PROVIDER_ERROR", message: "screenshot transfer was cancelled", reason: "cancelled" });
        }
        const response = await sendFirefoxBrokerRequest(
          session,
          "artifact_read_chunk",
          { artifact_id: artifactId, sequence, offset: received },
          { ...brokerOptions(options, this.#audienceId), readRetry: READ_RETRY },
        );
        if (!response.ok) {
          closeRemote();
          return failed(controlErrorFrom(response.error?.code === "ARTIFACT_EXPIRED" ? "ARTIFACT_EXPIRED" : response.error?.code, response.error?.reason, response.error?.message));
        }
        const chunk = (response.result ?? {}) as Record<string, unknown>;
        const data = Buffer.from(stringOrEmpty(chunk.data_base64), "base64");
        const rawBytes = typeof chunk.raw_bytes === "number" ? chunk.raw_bytes : -1;
        if (chunk.sequence !== sequence || chunk.offset !== received || rawBytes !== data.length || data.length > remote.chunk || received + data.length > remote.byteSize) {
          closeRemote();
          return failed({ code: "ARTIFACT_INTEGRITY_MISMATCH", message: "screenshot chunk framing was inconsistent", reason: "chunk_framing" });
        }
        chunks.push(data);
        received += data.length;
        if (chunk.eof === true) {
          const terminal = (chunk.terminal ?? {}) as { bytes?: unknown; sha256?: unknown };
          if (terminal.bytes !== remote.byteSize || terminal.sha256 !== remote.sha256 || received !== remote.byteSize) {
            closeRemote();
            return failed({ code: "ARTIFACT_INTEGRITY_MISMATCH", message: "terminal record does not match the descriptor", reason: "terminal_mismatch" });
          }
          break;
        }
      }
    } catch (error) {
      closeRemote();
      if (isFirefoxBrokerTransportError(error)) return failed({ code: "TRANSPORT_DISCONNECTED", message: error.message, reason: error.phase });
      throw error;
    }

    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== remote.sha256) {
      closeRemote();
      return failed({ code: "ARTIFACT_INTEGRITY_MISMATCH", message: "assembled screenshot does not match its digest", reason: "digest_mismatch" });
    }
    closeRemote();

    const rectRaw = (raw.captured_rect ?? {}) as Record<string, unknown>;
    const mediaType = raw.media_type === "image/jpeg" ? "image/jpeg" : "image/png";
    const descriptor: BrowserArtifactDescriptorV1 = {
      artifactId,
      kind: "screenshot",
      mediaType,
      width: typeof raw.width === "number" ? raw.width : 0,
      height: typeof raw.height === "number" ? raw.height : 0,
      byteSize: bytes.length,
      sha256: remote.sha256,
      contextId: stringOrEmpty(raw.context_id) || request.contextId,
      documentId: nullableString(raw.document_id),
      capturedRect: {
        x: typeof rectRaw.x === "number" ? rectRaw.x : 0,
        y: typeof rectRaw.y === "number" ? rectRaw.y : 0,
        width: typeof rectRaw.width === "number" ? rectRaw.width : 0,
        height: typeof rectRaw.height === "number" ? rectRaw.height : 0,
      },
      appliedScale: typeof raw.applied_scale === "number" ? raw.applied_scale : 1,
      grantRevision: typeof raw.grant_revision === "number" ? raw.grant_revision : 0,
      bindingToken: stringOrEmpty(raw.binding_token),
      createdAt: typeof raw.created_at === "number" ? raw.created_at : Date.now(),
      expiresAt: typeof raw.expires_at === "number" ? raw.expires_at : Date.now() + BROWSER_ARTIFACT_LIMITS_V1.defaultLifetimeMs,
    };
    try {
      const stored = this.#artifactStore().write(descriptor, bytes);
      return { outcome: "completed", receipt: this.#receipt(session, request.requestId, "screenshot.capture", "completed", { contextIds: [request.contextId] }), value: stored, replayed: false };
    } catch (error) {
      if (error instanceof ArtifactError) return failed({ code: error.code, message: error.message, reason: error.reason });
      throw error;
    }
  }

  /** Artifacts live only while the access binding they were captured under does. */
  async #requireArtifactAuthority(descriptor: BrowserArtifactDescriptorV1, options: BrowserOperationOptionsV2): Promise<void> {
    let detail: BrowserAuthorizationDetailV1;
    try {
      detail = await this.authorizationDetail({}, options);
    } catch {
      throw new ArtifactError("ARTIFACT_EXPIRED", "authority_unverifiable", "cannot verify that access to this artifact still exists");
    }
    if (detail.state !== "granted" || detail.bindingToken !== descriptor.bindingToken || !detail.actions.includes("capture")) {
      this.#artifactStore().remove(descriptor.artifactId);
      throw new ArtifactError("ARTIFACT_EXPIRED", "authority_ended", "the access this screenshot was captured under has ended");
    }
  }

  async describeArtifact(artifactId: string): Promise<BrowserArtifactDescriptorV1> {
    const descriptor = this.#artifactStore().describe(artifactId);
    await this.#requireArtifactAuthority(descriptor, {});
    return descriptor;
  }

  async readArtifact(artifactId: string, options: BrowserOperationOptionsV2 = {}): Promise<BrowserArtifactBytesV1> {
    const store = this.#artifactStore();
    const descriptor = store.describe(artifactId);
    await this.#requireArtifactAuthority(descriptor, options);
    const { data } = store.read(artifactId);
    return { descriptor, data };
  }

  async closeArtifact(artifactId: string): Promise<void> {
    this.#artifactStore().remove(artifactId);
  }

  async close(): Promise<void> {
    this.#trackedRefs.clear();
    // Teardown removes this consumer's artifacts; they are never a durable store.
    try { this.#artifacts?.clear(); } catch { /* best effort */ }
  }
}

export function createFirefoxBrowserProviderV2(options: FirefoxBrowserProviderOptions = {}): BrowserProviderV2 {
  return new FirefoxBrowserProviderV2(options);
}

export const createBrowserProviderV2 = createFirefoxBrowserProviderV2;
