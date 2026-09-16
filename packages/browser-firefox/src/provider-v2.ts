import {
  BROWSER_PROVIDER_V2,
  BROWSER_PROVIDER_V2_COMMON_CAPABILITIES,
  BROWSER_PROVIDER_V2_RECEIPT_SCHEMA,
  BROWSER_PROVIDER_V2_SEMANTICS_SCHEMA,
  validateBrowserActionReceiptV2,
  type BrowserActionCapabilityIdV2,
  type BrowserActionSemanticsV2,
  type BrowserActionV2,
  type BrowserContextCapabilitiesV2,
  type BrowserContextSummaryV2,
  type BrowserDocumentProvenanceV2,
  type BrowserFreshnessV2,
  type BrowserMutationRequestV2,
  type BrowserMutationResultV2,
  type BrowserOperationOptionsV2,
  type BrowserProviderDeclarationV2,
  type BrowserProviderErrorCodeV2,
  type BrowserProviderErrorV2,
  type BrowserProviderStatusV2,
  type BrowserProviderV2,
  type BrowserSnapshotV2,
  type BrowserTargetProvenanceV2,
} from "@zamery/browser-provider";

import { sendFirefoxBrokerRequest } from "./client.js";
import { listLiveFirefoxSessions, selectFirefoxSession } from "./session.js";
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

interface RawAuthorizationStatus {
  state?: unknown;
  current_host_session_id?: unknown;
  granted_host_session_id?: unknown;
  granted_at?: unknown;
}

interface RawStatus {
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

interface RawContextsResult {
  browser_instance_id?: unknown;
  contexts?: unknown;
}

interface RawSnapshotNode {
  ref?: unknown;
  role?: unknown;
  name?: unknown;
  tag?: unknown;
  value?: unknown;
  contenteditable?: unknown;
}

interface RawSnapshotResult {
  context_id?: unknown;
  snapshot_id?: unknown;
  document_id?: unknown;
  browser_document_id?: unknown;
  document_identity?: unknown;
  url?: unknown;
  title?: unknown;
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

function brokerOptions(options: BrowserOperationOptionsV2, id?: string): { id?: string; signal?: AbortSignal } {
  return {
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

export class FirefoxBrowserProviderV2 implements BrowserProviderV2 {
  readonly protocolVersion = BROWSER_PROVIDER_V2;
  readonly #browserInstanceId: string | undefined;
  readonly #sessionMaxAgeMs: number | undefined;
  readonly #sessionsDir: string | undefined;
  readonly #trackedRefs = new Map<string, TrackedRef>();

  constructor(options: FirefoxBrowserProviderOptions = {}) {
    this.#browserInstanceId = options.browserInstanceId;
    this.#sessionMaxAgeMs = options.sessionMaxAgeMs;
    this.#sessionsDir = options.sessionsDir;
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

  async status(options: BrowserOperationOptionsV2 = {}): Promise<BrowserProviderStatusV2> {
    const session = this.#sessionFor();
    const response = await sendFirefoxBrokerRequest(session, "status", {}, brokerOptions(options));
    const raw = assertOk(response) as RawStatus;
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
    const response = await sendFirefoxBrokerRequest(session, "list_contexts", {}, brokerOptions(options));
    const raw = assertOk(response) as RawContextsResult;
    const browserInstanceId = stringOrEmpty(raw.browser_instance_id) || request.browserInstanceId;
    const contexts = Array.isArray(raw.contexts) ? raw.contexts as RawContext[] : [];
    return contexts.map((context) => ({
      browserInstanceId,
      providerSessionId: session.session_id,
      contextId: stringOrEmpty(context.context_id),
      ownership: { owner: "user", lifecycle: "preserve" },
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
      brokerOptions(options),
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

    const response = await sendFirefoxBrokerRequest(
      session,
      "act",
      { context_id: request.contextId, ...actionParams(request.action) },
      brokerOptions(options, request.requestId),
    );
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

  async close(): Promise<void> {
    this.#trackedRefs.clear();
  }
}

export function createFirefoxBrowserProviderV2(options: FirefoxBrowserProviderOptions = {}): BrowserProviderV2 {
  return new FirefoxBrowserProviderV2(options);
}

export const createBrowserProviderV2 = createFirefoxBrowserProviderV2;
