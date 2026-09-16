export const BROWSER_PROVIDER_V2 = 2 as const;
export const BROWSER_PROVIDER_V2_SEMANTICS_SCHEMA = 1 as const;
export const BROWSER_PROVIDER_V2_RECEIPT_SCHEMA = 1 as const;

export const BROWSER_PROVIDER_V2_COMMON_CAPABILITIES = [
  "browser.live-existing",
  "context.list",
  "snapshot.semantic",
  "action.click",
  "action.fill",
  "action.type",
  "action.key",
  "mutation.cancel-before-start",
  "mutation.durable-replay",
  "authorization.session-bound",
] as const;

export const BROWSER_PROVIDER_V2_MAX_PROVIDER_EVIDENCE = 16;
export const BROWSER_PROVIDER_V2_MAX_ARTIFACT_REFS = 16;
export const BROWSER_PROVIDER_V2_MAX_EXTENSION_FIELDS = 32;
export const BROWSER_PROVIDER_V2_MAX_EXTENSION_ARRAY_ITEMS = 32;
export const BROWSER_PROVIDER_V2_MAX_SEMANTIC_STRING_LENGTH = 2_048;

export type BrowserCommonCapabilityIdV2 = (typeof BROWSER_PROVIDER_V2_COMMON_CAPABILITIES)[number];
export type BrowserActionCapabilityIdV2 = "action.click" | "action.fill" | "action.type" | "action.key";
export type BrowserInstanceIdV2 = string;
export type BrowserContextIdV2 = string;
export type BrowserElementRefV2 = string;
export type BrowserRequestIdV2 = string;
export type BrowserProviderSessionIdV2 = string;
export type BrowserObservationIdV2 = string;

export type BrowserCapabilityAvailabilityV2 =
  | { state: "ready" }
  | { state: "unsupported"; reason: string }
  | { state: "unavailable"; reason: string };

export type BrowserOwnershipV2 = Readonly<{
  owner: "user" | "provider" | "task" | "external";
  lifecycle: "preserve" | "provider-managed" | "task-managed" | "detach-only";
}>;

export type BrowserFreshnessV2 =
  | Readonly<{
      state: "fresh";
      observedAt: number;
      basis: "provider-observed" | "action-time-validated";
    }>
  | Readonly<{
      state: "stale";
      observedAt: number;
      reason: string;
    }>
  | Readonly<{
      state: "unknown";
      observedAt: number;
      reason: "external-control" | "provider-cannot-observe" | "observation-expired" | "other";
      previousState?: BrowserFreshnessV2["state"];
    }>;

export interface BrowserFrameProvenanceV2 {
  frameId: string;
  isTop: boolean;
  parentFrameId: string | null;
}

export interface BrowserDocumentProvenanceV2 {
  documentId: string;
  identitySource: "browser-native" | "provider-native" | "provider-epoch" | "unknown";
}

export interface BrowserTargetProvenanceV2 {
  browserInstanceId: BrowserInstanceIdV2;
  providerSessionId: BrowserProviderSessionIdV2;
  contextId: BrowserContextIdV2;
  frame: BrowserFrameProvenanceV2;
  document: BrowserDocumentProvenanceV2;
}

export type BrowserStructuredSemanticScalarV2 = string | number | boolean | null;
export type BrowserStructuredSemanticValueV2 =
  | BrowserStructuredSemanticScalarV2
  | readonly BrowserStructuredSemanticScalarV2[];

export interface BrowserProviderSemanticExtensionV2 {
  namespace: string;
  semanticId: string;
  version: number;
  fields: Readonly<Record<string, BrowserStructuredSemanticValueV2>>;
}

export type BrowserActionMechanismV2 =
  | "dom-synthetic"
  | "native-input"
  | "automation-api"
  | "provider-specific";

export type BrowserDomEventTrustExpectationV2 =
  | "trusted"
  | "untrusted"
  | "mixed"
  | "not-observed"
  | "unknown";

export type BrowserDefaultBehaviorDomainV2 =
  | "activation"
  | "navigation"
  | "text-editing"
  | "keyboard-default"
  | "form-submit";

export interface BrowserDefaultBehaviorClaimV2 {
  domain: BrowserDefaultBehaviorDomainV2;
  support: "guaranteed" | "not-guaranteed" | "unknown";
}

export interface BrowserActionSemanticsV2 {
  schemaVersion: typeof BROWSER_PROVIDER_V2_SEMANTICS_SCHEMA;
  action: BrowserActionCapabilityIdV2;
  mechanism: BrowserActionMechanismV2;
  domEventTrustExpectation: BrowserDomEventTrustExpectationV2;
  userActivation: "capable" | "not-capable" | "unknown";
  defaultBehavior: readonly BrowserDefaultBehaviorClaimV2[];
}

export interface BrowserProviderDeclarationV2 {
  protocolVersion: typeof BROWSER_PROVIDER_V2;
  semanticsSchemaVersion: typeof BROWSER_PROVIDER_V2_SEMANTICS_SCHEMA;
  providerId: string;
  commonCapabilities: readonly BrowserCommonCapabilityIdV2[];
  actions: readonly BrowserActionSemanticsV2[];
  providerExtensions: readonly BrowserProviderSemanticExtensionV2[];
}

export interface BrowserAuthorizationStatusV2 {
  state: "granted" | "revoked" | "not-required";
  currentBindingId: string | null;
  grantedBindingId: string | null;
  grantedAt: number | null;
}

export interface BrowserProviderStatusV2 {
  protocolVersion: typeof BROWSER_PROVIDER_V2;
  providerId: string;
  providerSessionId: BrowserProviderSessionIdV2;
  authorization: BrowserAuthorizationStatusV2;
}

export interface BrowserInstanceSummaryV2 {
  browserInstanceId: BrowserInstanceIdV2;
  providerSessionId: BrowserProviderSessionIdV2;
  profileId?: string;
  label?: string;
  ownership: BrowserOwnershipV2;
}

export interface BrowserContextCapabilitiesV2 {
  snapshot: BrowserCapabilityAvailabilityV2;
  actions: Readonly<Partial<Record<BrowserActionCapabilityIdV2, BrowserCapabilityAvailabilityV2>>>;
}

export interface BrowserContextSummaryV2 {
  browserInstanceId: BrowserInstanceIdV2;
  providerSessionId: BrowserProviderSessionIdV2;
  contextId: BrowserContextIdV2;
  ownership: BrowserOwnershipV2;
  title: string;
  url: string;
  active: boolean;
  capabilities: BrowserContextCapabilitiesV2;
}

export interface BrowserSnapshotNodeV2 {
  ref: BrowserElementRefV2;
  target: BrowserTargetProvenanceV2;
  freshness: BrowserFreshnessV2;
  role?: string;
  name?: string;
  tag?: string;
  value?: string;
  contenteditable?: boolean;
}

export interface BrowserSnapshotV2 {
  browserInstanceId: BrowserInstanceIdV2;
  providerSessionId: BrowserProviderSessionIdV2;
  contextId: BrowserContextIdV2;
  observationId: BrowserObservationIdV2;
  url: string;
  title: string;
  target: BrowserTargetProvenanceV2;
  freshness: BrowserFreshnessV2;
  nodes: readonly BrowserSnapshotNodeV2[];
}

export type BrowserActionV2 =
  | Readonly<{
      capability: "action.click";
      ref: BrowserElementRefV2;
      observationId: BrowserObservationIdV2;
    }>
  | Readonly<{
      capability: "action.fill";
      ref: BrowserElementRefV2;
      observationId: BrowserObservationIdV2;
      value: string;
    }>
  | Readonly<{
      capability: "action.type";
      ref: BrowserElementRefV2;
      observationId: BrowserObservationIdV2;
      text: string;
    }>
  | Readonly<{
      capability: "action.key";
      ref: BrowserElementRefV2;
      observationId: BrowserObservationIdV2;
      key: string;
    }>;

export interface BrowserMutationRequestV2 {
  requestId: BrowserRequestIdV2;
  browserInstanceId: BrowserInstanceIdV2;
  providerSessionId: BrowserProviderSessionIdV2;
  contextId: BrowserContextIdV2;
  action: BrowserActionV2;
}

export interface BrowserArtifactReferenceV2 {
  artifactId: string;
  kind: "screenshot" | "trace" | "video" | "log" | "other";
  mediaType?: string;
  digest?: Readonly<{ algorithm: "sha256"; value: string }>;
}

export interface BrowserInvocationObservationV2 {
  schemaVersion: typeof BROWSER_PROVIDER_V2_RECEIPT_SCHEMA;
  observedAt: number;
  targetValidation: BrowserFreshnessV2;
  domEventTrust?:
    | Readonly<{ observed: false }>
    | Readonly<{ observed: true; isTrusted: boolean }>;
  documentBefore?: BrowserDocumentProvenanceV2;
  documentAfter?: BrowserDocumentProvenanceV2;
  providerEvidence?: readonly BrowserProviderSemanticExtensionV2[];
  artifacts?: readonly BrowserArtifactReferenceV2[];
}

export interface BrowserActionReceiptV2 {
  receiptKind: "browser-action";
  schemaVersion: typeof BROWSER_PROVIDER_V2_RECEIPT_SCHEMA;
  protocolVersion: typeof BROWSER_PROVIDER_V2;
  providerId: string;
  providerSessionId: BrowserProviderSessionIdV2;
  requestId: BrowserRequestIdV2;
  action: BrowserActionCapabilityIdV2;
  declaredSemantics: BrowserActionSemanticsV2;
  observed: BrowserInvocationObservationV2;
}

export type BrowserMutationOutcomeV2 =
  | "not_started"
  | "completed"
  | "partially_applied"
  | "outcome_unknown";

export type BrowserCancellationReceiptV2 =
  | { requested: false }
  | { requested: true; effect: "prevented_before_start" | "none_after_start" };

export type BrowserProviderErrorCodeV2 =
  | "BROWSER_CONTEXT_NOT_FOUND"
  | "BROWSER_CONTEXT_GONE"
  | "BROWSER_CONTEXT_UNAVAILABLE"
  | "BROWSER_INSTANCE_AMBIGUOUS"
  | "BROWSER_INSTANCE_NOT_FOUND"
  | "STALE_ELEMENT_REF"
  | "OBSERVATION_FRESHNESS_UNKNOWN"
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
  | "CONTEXT_NOT_OWNED"
  | "PROVIDER_SESSION_CHANGED";

export interface BrowserProviderErrorV2 {
  code: BrowserProviderErrorCodeV2;
  message: string;
  reason?: string;
  freshness?: BrowserFreshnessV2;
}

export type BrowserMutationResultV2 =
  | Readonly<{
      outcome: "completed";
      receipt: BrowserActionReceiptV2;
      cancellation: BrowserCancellationReceiptV2;
      replayed: boolean;
    }>
  | Readonly<{
      outcome: "not_started";
      error: BrowserProviderErrorV2;
      cancellation?: { requested: true; effect: "prevented_before_start" };
      replayed: boolean;
    }>
  | Readonly<{
      outcome: "partially_applied" | "outcome_unknown";
      error: BrowserProviderErrorV2;
      replayed: boolean;
    }>;

export interface BrowserOperationOptionsV2 {
  signal?: AbortSignal;
}

export interface BrowserProviderV2 {
  readonly protocolVersion: typeof BROWSER_PROVIDER_V2;

  declaration(): Promise<BrowserProviderDeclarationV2>;
  status(options?: BrowserOperationOptionsV2): Promise<BrowserProviderStatusV2>;
  listInstances(options?: BrowserOperationOptionsV2): Promise<readonly BrowserInstanceSummaryV2[]>;
  listContexts(
    request: { browserInstanceId: BrowserInstanceIdV2; providerSessionId?: BrowserProviderSessionIdV2 },
    options?: BrowserOperationOptionsV2,
  ): Promise<readonly BrowserContextSummaryV2[]>;
  snapshot(
    request: {
      browserInstanceId: BrowserInstanceIdV2;
      providerSessionId?: BrowserProviderSessionIdV2;
      contextId: BrowserContextIdV2;
    },
    options?: BrowserOperationOptionsV2,
  ): Promise<BrowserSnapshotV2>;
  act(request: BrowserMutationRequestV2, options?: BrowserOperationOptionsV2): Promise<BrowserMutationResultV2>;
  close(): Promise<void>;
}

export class BrowserProviderV2ContractError extends Error {
  readonly code:
    | "INVALID_PROVIDER_EXTENSION"
    | "INVALID_ACTION_RECEIPT"
    | "PROVIDER_EVIDENCE_LIMIT_EXCEEDED"
    | "ARTIFACT_LIMIT_EXCEEDED";

  constructor(
    code: BrowserProviderV2ContractError["code"],
    message: string,
  ) {
    super(message);
    this.name = "BrowserProviderV2ContractError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function semanticScalarValid(value: unknown): value is BrowserStructuredSemanticScalarV2 {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function semanticValueValid(value: unknown): value is BrowserStructuredSemanticValueV2 {
  if (semanticScalarValid(value)) {
    return typeof value !== "string" || value.length <= BROWSER_PROVIDER_V2_MAX_SEMANTIC_STRING_LENGTH;
  }
  if (!Array.isArray(value) || value.length > BROWSER_PROVIDER_V2_MAX_EXTENSION_ARRAY_ITEMS) return false;
  return value.every((item) => semanticScalarValid(item)
    && (typeof item !== "string" || item.length <= BROWSER_PROVIDER_V2_MAX_SEMANTIC_STRING_LENGTH));
}

export function validateProviderSemanticExtensionV2(
  extension: BrowserProviderSemanticExtensionV2,
): void {
  const namespaceValid = /^[a-z][a-z0-9.-]*$/.test(extension.namespace)
    && extension.namespace !== "common"
    && extension.namespace !== "browser.common";
  const fields = Object.entries(extension.fields);
  if (
    !namespaceValid
    || !extension.semanticId.startsWith(`${extension.namespace}/`)
    || !Number.isInteger(extension.version)
    || extension.version < 1
    || fields.length > BROWSER_PROVIDER_V2_MAX_EXTENSION_FIELDS
    || fields.some(([key, value]) => key.length === 0 || !semanticValueValid(value))
  ) {
    throw new BrowserProviderV2ContractError(
      "INVALID_PROVIDER_EXTENSION",
      `invalid provider semantic extension: ${extension.semanticId}`,
    );
  }
}

export function freshnessUnknownAfterExternalControl(
  previous: BrowserFreshnessV2,
  observedAt: number = Date.now(),
): BrowserFreshnessV2 {
  return {
    state: "unknown",
    observedAt,
    reason: "external-control",
    previousState: previous.state,
  };
}

export function validateBrowserActionReceiptV2(receipt: BrowserActionReceiptV2): void {
  if (
    receipt.receiptKind !== "browser-action"
    || receipt.schemaVersion !== BROWSER_PROVIDER_V2_RECEIPT_SCHEMA
    || receipt.protocolVersion !== BROWSER_PROVIDER_V2
    || receipt.providerId.length === 0
    || receipt.providerSessionId.length === 0
    || receipt.requestId.length === 0
    || receipt.declaredSemantics.schemaVersion !== BROWSER_PROVIDER_V2_SEMANTICS_SCHEMA
    || receipt.declaredSemantics.action !== receipt.action
    || receipt.observed.schemaVersion !== BROWSER_PROVIDER_V2_RECEIPT_SCHEMA
    || receipt.observed.targetValidation.state !== "fresh"
    || receipt.observed.targetValidation.basis !== "action-time-validated"
  ) {
    throw new BrowserProviderV2ContractError(
      "INVALID_ACTION_RECEIPT",
      "browser action receipt is missing required V2 identity or action-time validation",
    );
  }

  const providerEvidence = receipt.observed.providerEvidence ?? [];
  if (providerEvidence.length > BROWSER_PROVIDER_V2_MAX_PROVIDER_EVIDENCE) {
    throw new BrowserProviderV2ContractError(
      "PROVIDER_EVIDENCE_LIMIT_EXCEEDED",
      `provider evidence exceeds ${BROWSER_PROVIDER_V2_MAX_PROVIDER_EVIDENCE} items`,
    );
  }
  for (const extension of providerEvidence) validateProviderSemanticExtensionV2(extension);

  const artifacts = receipt.observed.artifacts ?? [];
  if (artifacts.length > BROWSER_PROVIDER_V2_MAX_ARTIFACT_REFS) {
    throw new BrowserProviderV2ContractError(
      "ARTIFACT_LIMIT_EXCEEDED",
      `artifact references exceed ${BROWSER_PROVIDER_V2_MAX_ARTIFACT_REFS} items`,
    );
  }
  if (artifacts.some((artifact) => artifact.artifactId.length === 0 || artifact.artifactId.length > 256)) {
    throw new BrowserProviderV2ContractError(
      "INVALID_ACTION_RECEIPT",
      "browser action receipt contains an invalid artifact reference",
    );
  }
}

export function isBrowserActionReceiptV2(value: unknown): value is BrowserActionReceiptV2 {
  if (!isRecord(value)) return false;
  try {
    validateBrowserActionReceiptV2(value as unknown as BrowserActionReceiptV2);
    return true;
  } catch {
    return false;
  }
}
