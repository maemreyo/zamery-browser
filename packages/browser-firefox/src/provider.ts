import {
  BROWSER_PROVIDER_V1,
  BROWSER_PROVIDER_V1_CAPABILITIES,
  type BrowserAction,
  type BrowserActionCapabilityId,
  type BrowserContextCapabilities,
  type BrowserContextSummary,
  type BrowserInstanceSummary,
  type BrowserMutationRequest,
  type BrowserMutationResult,
  type BrowserOperationOptions,
  type BrowserProvider,
  type BrowserProviderError,
  type BrowserProviderErrorCode,
  type BrowserProviderStatus,
  type BrowserSnapshot,
} from "@zamery/browser-provider";

import { sendFirefoxBrokerRequest } from "./client.js";
import { listLiveFirefoxSessions, selectFirefoxSession } from "./session.js";
import type { FirefoxBrokerResponse, FirefoxSessionReceipt } from "./protocol.js";

const PROVIDER_ID = "firefox";

const PROVIDER_ERROR_CODES = new Set<BrowserProviderErrorCode>([
  "BROWSER_CONTEXT_NOT_FOUND",
  "BROWSER_CONTEXT_GONE",
  "BROWSER_CONTEXT_UNAVAILABLE",
  "BROWSER_INSTANCE_AMBIGUOUS",
  "BROWSER_INSTANCE_NOT_FOUND",
  "STALE_ELEMENT_REF",
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
]);

interface RawAuthorizationStatus {
  state?: unknown;
  current_host_session_id?: unknown;
  granted_host_session_id?: unknown;
  granted_at?: unknown;
}

interface RawStatus {
  protocol_version?: unknown;
  browser_instance_id?: unknown;
  profile_id?: unknown;
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
  url?: unknown;
  title?: unknown;
  nodes?: unknown;
}

interface RawMutationResult {
  outcome?: unknown;
  result?: {
    mechanism?: unknown;
    observed_is_trusted?: unknown;
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

export interface FirefoxBrowserProviderOptions {
  browserInstanceId?: string;
  sessionMaxAgeMs?: number;
  sessionsDir?: string;
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

function errorCode(value: unknown): BrowserProviderErrorCode {
  if (value === "CONTEXT_UNAVAILABLE") return "BROWSER_CONTEXT_UNAVAILABLE";
  if (typeof value === "string" && PROVIDER_ERROR_CODES.has(value as BrowserProviderErrorCode)) {
    return value as BrowserProviderErrorCode;
  }
  return "BROWSER_PROVIDER_ERROR";
}

function errorFromResponse(response: FirefoxBrokerResponse): BrowserProviderError {
  return {
    code: errorCode(response.error?.code),
    message: response.error?.message || "Firefox provider request failed",
    ...(response.error?.reason ? { reason: response.error.reason } : {}),
  };
}

function errorFromRawMutation(raw: RawMutationResult): BrowserProviderError {
  const reason = typeof raw.error?.reason === "string" ? raw.error.reason : undefined;
  const message = typeof raw.error?.message === "string"
    ? raw.error.message
    : reason || "Firefox browser mutation did not start";
  return {
    code: errorCode(raw.error?.code),
    message,
    ...(reason ? { reason } : {}),
  };
}

function assertOk(response: FirefoxBrokerResponse): unknown {
  if (!response.ok) {
    const error = errorFromResponse(response);
    throw Object.assign(new Error(error.message), error);
  }
  return response.result;
}

function brokerOptions(options: BrowserOperationOptions, id?: string): { id?: string; signal?: AbortSignal } {
  return {
    ...(id === undefined ? {} : { id }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function actionParams(action: BrowserAction): Record<string, unknown> {
  if (action.capability === "action.click.dom-synthetic") {
    return { action: "click", ref: action.ref };
  }
  if (action.capability === "action.fill.dom-synthetic") {
    return { action: "fill", ref: action.ref, value: action.value };
  }
  if (action.capability === "action.type.text-input.dom-synthetic") {
    return { action: "type", ref: action.ref, text: action.text };
  }
  return { action: "key", ref: action.ref, key: action.key };
}

function actionCapabilities(availability: RawContextAvailability | undefined): BrowserContextCapabilities {
  const reason = stringOrEmpty(availability?.reason) || "context_unavailable";
  const snapshotReady = availability?.inspect === true;
  const actReady = availability?.act === true;
  const actionIds: BrowserActionCapabilityId[] = [
    "action.click.dom-synthetic",
    "action.fill.dom-synthetic",
    "action.type.text-input.dom-synthetic",
    "action.key-event.dom-synthetic",
  ];
  return {
    snapshot: snapshotReady ? { state: "ready" } : { state: "unavailable", reason },
    actions: Object.fromEntries(
      actionIds.map((id) => [id, actReady ? { state: "ready" } : { state: "unavailable", reason }]),
    ) as BrowserContextCapabilities["actions"],
  };
}

function mapContext(raw: RawContext, browserInstanceId: string): BrowserContextSummary {
  return {
    browserInstanceId,
    contextId: stringOrEmpty(raw.context_id),
    ownership: raw.ownership === "provider-owned" ? "provider-owned" : "user-owned",
    title: stringOrEmpty(raw.title),
    url: stringOrEmpty(raw.url),
    active: raw.active === true,
    capabilities: actionCapabilities(raw.availability),
  };
}

export class FirefoxBrowserProvider implements BrowserProvider {
  readonly protocolVersion = BROWSER_PROVIDER_V1;
  readonly #browserInstanceId: string | undefined;
  readonly #sessionMaxAgeMs: number | undefined;
  readonly #sessionsDir: string | undefined;

  constructor(options: FirefoxBrowserProviderOptions = {}) {
    this.#browserInstanceId = options.browserInstanceId;
    this.#sessionMaxAgeMs = options.sessionMaxAgeMs;
    this.#sessionsDir = options.sessionsDir;
  }

  async capabilities() {
    return { protocolVersion: BROWSER_PROVIDER_V1, ids: BROWSER_PROVIDER_V1_CAPABILITIES };
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
    const matching = sessions.filter((session) => session.browser_instance_id === requested);
    return selectFirefoxSession(matching);
  }

  async status(options: BrowserOperationOptions = {}): Promise<BrowserProviderStatus> {
    const session = this.#sessionFor();
    const response = await sendFirefoxBrokerRequest(session, "status", {}, brokerOptions(options));
    const raw = assertOk(response) as RawStatus;
    const auth = raw.authorization ?? {};
    return {
      protocolVersion: BROWSER_PROVIDER_V1,
      providerId: PROVIDER_ID,
      authorization: {
        state: auth.state === "granted" ? "granted" : "revoked",
        currentBindingId: nullableString(auth.current_host_session_id),
        grantedBindingId: nullableString(auth.granted_host_session_id),
        grantedAt: nullableNumber(auth.granted_at),
      },
    };
  }

  async listInstances(): Promise<readonly BrowserInstanceSummary[]> {
    const byId = new Map<string, BrowserInstanceSummary>();
    for (const session of this.#sessions()) {
      const browserInstanceId = nullableString(session.browser_instance_id);
      const profileId = nullableString(session.profile_id);
      if (!browserInstanceId || !profileId) continue;
      byId.set(browserInstanceId, { browserInstanceId, profileId });
    }
    return [...byId.values()];
  }

  async listContexts(
    request: { browserInstanceId: string },
    options: BrowserOperationOptions = {},
  ): Promise<readonly BrowserContextSummary[]> {
    const session = this.#sessionFor(request.browserInstanceId);
    const response = await sendFirefoxBrokerRequest(session, "list_contexts", {}, brokerOptions(options));
    const raw = assertOk(response) as RawContextsResult;
    const browserInstanceId = stringOrEmpty(raw.browser_instance_id) || request.browserInstanceId;
    const contexts = Array.isArray(raw.contexts) ? raw.contexts as RawContext[] : [];
    return contexts.map((context) => mapContext(context, browserInstanceId));
  }

  async snapshot(
    request: { browserInstanceId: string; contextId: string },
    options: BrowserOperationOptions = {},
  ): Promise<BrowserSnapshot> {
    const session = this.#sessionFor(request.browserInstanceId);
    const response = await sendFirefoxBrokerRequest(
      session,
      "snapshot",
      { context_id: request.contextId },
      brokerOptions(options),
    );
    const raw = assertOk(response) as RawSnapshotResult;
    const nodes = Array.isArray(raw.nodes) ? raw.nodes as RawSnapshotNode[] : [];
    return {
      browserInstanceId: request.browserInstanceId,
      contextId: stringOrEmpty(raw.context_id) || request.contextId,
      snapshotId: stringOrEmpty(raw.snapshot_id),
      documentId: stringOrEmpty(raw.document_id),
      url: stringOrEmpty(raw.url),
      title: stringOrEmpty(raw.title),
      nodes: nodes.map((node) => ({
        ref: stringOrEmpty(node.ref),
        ...(typeof node.role === "string" ? { role: node.role } : {}),
        ...(typeof node.name === "string" ? { name: node.name } : {}),
        ...(typeof node.tag === "string" ? { tag: node.tag } : {}),
        ...(typeof node.value === "string" ? { value: node.value } : {}),
        ...(typeof node.contenteditable === "boolean" ? { contenteditable: node.contenteditable } : {}),
      })),
    };
  }

  async act(
    request: BrowserMutationRequest,
    options: BrowserOperationOptions = {},
  ): Promise<BrowserMutationResult> {
    const session = this.#sessionFor(request.browserInstanceId);
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
    const cancellation = raw.cancellation?.requested === true
      ? { requested: true as const, effect: "none_after_start" as const }
      : { requested: false as const };
    return {
      outcome: "completed",
      receipt: {
        capability: request.action.capability,
        mechanism: "dom-synthetic",
        observedIsTrusted: false,
        defaultBehaviorGuarantee: "none",
      },
      cancellation,
      replayed: response.replayed === true,
    };
  }

  async close(): Promise<void> {
    // This provider owns no browser process, companion, native-host process, or persistent socket.
    // Each broker request is a bounded exchange against infrastructure owned by Firefox/the operator.
  }

}

export function createFirefoxBrowserProvider(options: FirefoxBrowserProviderOptions = {}): BrowserProvider {
  return new FirefoxBrowserProvider(options);
}

/** Standard dynamic-provider export consumed by @zamery/pi-browser. */
export const createBrowserProvider = createFirefoxBrowserProvider;
