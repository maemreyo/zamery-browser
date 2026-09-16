export * from "./assets-v1.js";

export const BROWSER_PROVIDER_V1 = 1 as const;

export const BROWSER_PROVIDER_V1_CAPABILITIES = [
  "browser.live-existing",
  "context.list",
  "snapshot.semantic",
  "action.click.dom-synthetic",
  "action.fill.dom-synthetic",
  "action.type.text-input.dom-synthetic",
  "action.key-event.dom-synthetic",
  "mutation.cancel-before-start",
  "mutation.durable-replay",
  "authorization.session-bound",
] as const;

export type BrowserCapabilityId = (typeof BROWSER_PROVIDER_V1_CAPABILITIES)[number];

export type BrowserInstanceId = string;
export type BrowserContextId = string;
export type BrowserElementRef = string;
export type BrowserRequestId = string;

export type BrowserOwnership = "user-owned" | "provider-owned";

export type BrowserCapabilityAvailability =
  | { state: "ready" }
  | { state: "unsupported"; reason: string }
  | { state: "unavailable"; reason: string };

export type BrowserActionCapabilityId =
  | "action.click.dom-synthetic"
  | "action.fill.dom-synthetic"
  | "action.type.text-input.dom-synthetic"
  | "action.key-event.dom-synthetic";

export interface BrowserProviderCapabilities {
  protocolVersion: typeof BROWSER_PROVIDER_V1;
  ids: readonly BrowserCapabilityId[];
}

export interface BrowserAuthorizationStatus {
  state: "granted" | "revoked";
  currentBindingId: string | null;
  grantedBindingId: string | null;
  grantedAt: number | null;
}

export interface BrowserProviderStatus {
  protocolVersion: typeof BROWSER_PROVIDER_V1;
  providerId: string;
  authorization: BrowserAuthorizationStatus;
}

export interface BrowserInstanceSummary {
  browserInstanceId: BrowserInstanceId;
  profileId: string;
  label?: string;
}

export interface BrowserContextCapabilities {
  snapshot: BrowserCapabilityAvailability;
  actions: Readonly<Partial<Record<BrowserActionCapabilityId, BrowserCapabilityAvailability>>>;
}

export interface BrowserContextSummary {
  browserInstanceId: BrowserInstanceId;
  contextId: BrowserContextId;
  ownership: BrowserOwnership;
  title: string;
  url: string;
  active: boolean;
  capabilities: BrowserContextCapabilities;
}

export interface BrowserSnapshotNode {
  ref: BrowserElementRef;
  role?: string;
  name?: string;
  tag?: string;
  value?: string;
  contenteditable?: boolean;
}

export interface BrowserSnapshot {
  browserInstanceId: BrowserInstanceId;
  contextId: BrowserContextId;
  snapshotId: string;
  documentId: string;
  url: string;
  title: string;
  nodes: readonly BrowserSnapshotNode[];
}

export type BrowserAction =
  | {
      capability: "action.click.dom-synthetic";
      ref: BrowserElementRef;
    }
  | {
      capability: "action.fill.dom-synthetic";
      ref: BrowserElementRef;
      value: string;
    }
  | {
      capability: "action.type.text-input.dom-synthetic";
      ref: BrowserElementRef;
      text: string;
    }
  | {
      capability: "action.key-event.dom-synthetic";
      ref: BrowserElementRef;
      key: string;
    };

export interface BrowserMutationRequest {
  requestId: BrowserRequestId;
  browserInstanceId: BrowserInstanceId;
  contextId: BrowserContextId;
  action: BrowserAction;
}

export interface BrowserActionReceipt {
  capability: BrowserActionCapabilityId;
  mechanism: "dom-synthetic";
  observedIsTrusted: false;
  defaultBehaviorGuarantee: "none";
}

export type BrowserMutationOutcome =
  | "not_started"
  | "completed"
  | "partially_applied"
  | "outcome_unknown";

export type BrowserCancellationReceipt =
  | { requested: false }
  | { requested: true; effect: "prevented_before_start" | "none_after_start" };

export type BrowserProviderErrorCode =
  | "BROWSER_CONTEXT_NOT_FOUND"
  | "BROWSER_CONTEXT_GONE"
  | "BROWSER_CONTEXT_UNAVAILABLE"
  | "BROWSER_INSTANCE_AMBIGUOUS"
  | "BROWSER_INSTANCE_NOT_FOUND"
  | "STALE_ELEMENT_REF"
  | "UNSUPPORTED_CAPABILITY"
  | "UNSUPPORTED_INPUT_SEMANTICS"
  | "BROWSER_PROTOCOL_MISMATCH"
  | "BROWSER_REQUEST_TIMEOUT"
  | "BROWSER_REQUEST_CANCELLED"
  | "BROWSER_PROVIDER_ERROR"
  | "BROWSER_AUTHORIZATION_REQUIRED"
  | "REQUEST_ID_CONFLICT"
  | "MUTATION_OUTCOME_UNKNOWN"
  | "BROWSER_ACTION_RESPONSE_LOST"
  | "CONTEXT_NOT_OWNED";

export interface BrowserProviderError {
  code: BrowserProviderErrorCode;
  message: string;
  reason?: string;
}

export type BrowserMutationResult =
  | {
      outcome: "completed";
      receipt: BrowserActionReceipt;
      cancellation: BrowserCancellationReceipt;
      replayed: boolean;
    }
  | {
      outcome: "not_started";
      error: BrowserProviderError;
      cancellation?: { requested: true; effect: "prevented_before_start" };
      replayed: boolean;
    }
  | {
      outcome: "partially_applied" | "outcome_unknown";
      error: BrowserProviderError;
      replayed: boolean;
    };

export interface BrowserOperationOptions {
  signal?: AbortSignal;
}

export interface BrowserProvider {
  readonly protocolVersion: typeof BROWSER_PROVIDER_V1;

  capabilities(): Promise<BrowserProviderCapabilities>;
  status(options?: BrowserOperationOptions): Promise<BrowserProviderStatus>;
  listInstances(options?: BrowserOperationOptions): Promise<readonly BrowserInstanceSummary[]>;
  listContexts(
    request: { browserInstanceId: BrowserInstanceId },
    options?: BrowserOperationOptions,
  ): Promise<readonly BrowserContextSummary[]>;
  snapshot(
    request: { browserInstanceId: BrowserInstanceId; contextId: BrowserContextId },
    options?: BrowserOperationOptions,
  ): Promise<BrowserSnapshot>;
  act(request: BrowserMutationRequest, options?: BrowserOperationOptions): Promise<BrowserMutationResult>;
  close(): Promise<void>;
}

export class BrowserProviderContractError extends Error {
  readonly code: "BROWSER_INSTANCE_AMBIGUOUS" | "BROWSER_INSTANCE_NOT_FOUND";

  constructor(
    code: "BROWSER_INSTANCE_AMBIGUOUS" | "BROWSER_INSTANCE_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "BrowserProviderContractError";
    this.code = code;
  }
}

export function resolveBrowserInstance(
  instances: readonly BrowserInstanceSummary[],
  requestedId?: BrowserInstanceId,
): BrowserInstanceSummary {
  if (requestedId) {
    const selected = instances.find((instance) => instance.browserInstanceId === requestedId);
    if (!selected) {
      throw new BrowserProviderContractError(
        "BROWSER_INSTANCE_NOT_FOUND",
        `browser instance not found: ${requestedId}`,
      );
    }
    return selected;
  }

  if (instances.length === 1) return instances[0]!;
  if (instances.length === 0) {
    throw new BrowserProviderContractError(
      "BROWSER_INSTANCE_NOT_FOUND",
      "no browser instance is available",
    );
  }

  throw new BrowserProviderContractError(
    "BROWSER_INSTANCE_AMBIGUOUS",
    `multiple browser instances are available: ${instances.map((instance) => instance.browserInstanceId).join(",")}`,
  );
}

export function hasCapability(
  capabilities: BrowserProviderCapabilities,
  capability: BrowserCapabilityId,
): boolean {
  return capabilities.ids.includes(capability);
}

export * from "./v2.js";
