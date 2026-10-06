import type {
  BrowserInstanceIdV2,
  BrowserMutationOutcomeV2,
  BrowserOperationOptionsV2,
  BrowserProviderSessionIdV2,
} from "./v2.js";

/**
 * Optional BrowserControlProviderV1: claim / hand-off / mutation-status for a user-owned browser.
 *
 * Deliberately separate from BrowserProvider V2. Exporting it does not advertise that a provider
 * implements it; consumers must use {@link isBrowserControlProviderV1}. A claim never expands consent.
 */
export const BROWSER_CONTROL_PROVIDER_V1 = 1 as const;
export const BROWSER_CONTROL_RECEIPT_SCHEMA_V1 = 1 as const;

export type BrowserControlStateNameV1 =
  | "no_access"
  | "shared_idle"
  | "agent_claimed"
  | "user_control"
  | "rebinding";

export interface BrowserControlStateV1 {
  state: BrowserControlStateNameV1;
  /** Bumps on every claim/takeover/resume. Observations taken at another generation are stale. */
  claimGeneration: number;
  claimedContextId: string | null;
  claimedByYou: boolean;
  /** Machine-readable reason for the current state, e.g. `user_takeover`, `human_interaction`, `outcome_unknown`. */
  reason: string | null;
  resumeRequested: boolean;
}

/** Closed taxonomy for control-plane operations. These never extend the BrowserProvider V2 error enum. */
export type BrowserControlErrorCodeV1 =
  | "HOST_MISSING"
  | "COMPANION_NOT_READY"
  | "TRANSPORT_DISCONNECTED"
  | "PROTOCOL_MISMATCH"
  | "AUTHORIZATION_REQUIRED"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_REVOKED"
  | "REBIND_REQUIRED"
  | "OUTSIDE_SCOPE"
  | "CONTEXT_GONE"
  | "RESTRICTED_PAGE"
  | "PRIVATE_WINDOW_DENIED"
  | "CLAIM_REQUIRED"
  | "CLAIM_CHANGED"
  | "USER_CONTROL_ACTIVE"
  | "FOCUS_CHANGED"
  | "STALE_OBSERVATION"
  | "REQUEST_ID_CONFLICT"
  | "REPLAY_HORIZON_EXPIRED"
  | "OUTCOME_UNKNOWN"
  | "PARTIALLY_APPLIED"
  | "UNSUPPORTED_CAPABILITY"
  | "INVALID_ARGUMENT"
  | "RESOURCE_BUSY"
  | "ARTIFACT_EXPIRED"
  | "ARTIFACT_SIZE_LIMIT"
  | "ARTIFACT_INTEGRITY_MISMATCH"
  | "ARTIFACT_NOT_FOUND"
  | "PROVIDER_ERROR";

export interface BrowserControlErrorV1 {
  code: BrowserControlErrorCodeV1;
  message: string;
  /** Companion reason such as `origin_changed_confirmation_required`. Never page-derived text. */
  reason?: string;
}

export interface BrowserControlReceiptV1 {
  receiptKind: "browser-control";
  schemaVersion: typeof BROWSER_CONTROL_RECEIPT_SCHEMA_V1;
  protocolVersion: typeof BROWSER_CONTROL_PROVIDER_V1;
  providerId: string;
  providerSessionId: BrowserProviderSessionIdV2;
  requestId: string;
  /** e.g. `tab.create`, `group.move`. */
  operation: string;
  outcome: BrowserMutationOutcomeV2;
  /** Sub-steps that definitely happened, in order. Never inferred from a rollback. */
  completedSubsteps: readonly string[];
  observedAt: number;
  contextIds?: readonly string[];
  focusedContextId?: string;
}

export type BrowserControlResultV1<T = undefined> =
  | Readonly<{ outcome: "completed"; receipt: BrowserControlReceiptV1; value: T; replayed: boolean }>
  | Readonly<{ outcome: "not_started"; error: BrowserControlErrorV1; replayed: boolean }>
  | Readonly<{
      outcome: "partially_applied" | "outcome_unknown";
      error: BrowserControlErrorV1;
      receipt?: BrowserControlReceiptV1;
      replayed: boolean;
    }>;

export type BrowserMutationStatusStateV1 =
  | "in_flight"
  | "completed"
  | "outcome_unknown"
  | "not_found"
  | "outside_replay_horizon";

export interface BrowserMutationStatusV1 {
  requestId: string;
  state: BrowserMutationStatusStateV1;
  outcome?: BrowserMutationOutcomeV2;
  operation?: string;
  startedAt?: number;
  completedAt?: number;
  replayHorizonMs: number;
}

export interface BrowserControlTargetV1 {
  browserInstanceId: BrowserInstanceIdV2;
  providerSessionId?: BrowserProviderSessionIdV2;
}

export interface BrowserClaimRequestV1 extends BrowserControlTargetV1 {
  contextId: string;
}

export interface BrowserClaimValueV1 {
  contextId: string;
  claimGeneration: number;
}

export interface BrowserControlProviderV1 {
  readonly controlProtocolVersion: typeof BROWSER_CONTROL_PROVIDER_V1;

  controlState(request: BrowserControlTargetV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlStateV1>;
  claim(request: BrowserClaimRequestV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlResultV1<BrowserClaimValueV1>>;
  release(request: BrowserControlTargetV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlStateV1>;
  /** The agent asks the human to take over (MFA, login, chooser). Always allowed while access exists. */
  requestUserTakeover(
    request: BrowserControlTargetV1 & { note?: string },
    options?: BrowserOperationOptionsV2,
  ): Promise<BrowserControlStateV1>;
  /** The agent can only ask to resume; only the user's action in the browser releases user control. */
  requestResume(request: BrowserControlTargetV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlStateV1>;
  mutationStatus(
    request: BrowserControlTargetV1 & { requestId: string },
    options?: BrowserOperationOptionsV2,
  ): Promise<BrowserMutationStatusV1>;
}

export function isBrowserControlProviderV1(value: unknown): value is BrowserControlProviderV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrowserControlProviderV1>;
  return candidate.controlProtocolVersion === BROWSER_CONTROL_PROVIDER_V1
    && typeof candidate.controlState === "function"
    && typeof candidate.claim === "function"
    && typeof candidate.release === "function"
    && typeof candidate.requestUserTakeover === "function"
    && typeof candidate.requestResume === "function"
    && typeof candidate.mutationStatus === "function";
}
