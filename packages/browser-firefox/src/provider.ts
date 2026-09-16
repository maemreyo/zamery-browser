import { createHash, type Hash } from "node:crypto";

import {
  BROWSER_ASSET_PROVIDER_V1,
  BROWSER_ASSET_PROVIDER_V1_MAX_RAW_CHUNK_BYTES,
  BROWSER_ASSET_PROVIDER_V1_REPLAY_WINDOW_CHUNKS,
  BROWSER_PROVIDER_V1,
  BROWSER_PROVIDER_V1_CAPABILITIES,
  type BrowserAction,
  type BrowserAssetCloseRequest,
  type BrowserAssetCloseResult,
  type BrowserAssetContextCapabilities,
  type BrowserAssetDiscovery,
  type BrowserAssetDiscoveryRequest,
  type BrowserAssetOpenRequest,
  type BrowserAssetOpenResult,
  type BrowserAssetProviderV1,
  type BrowserAssetReadChunkRequest,
  type BrowserAssetReadChunkResult,
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

interface RawAssetDiscoveryAsset {
  asset_ref?: unknown;
  media_kind?: unknown;
  safe_label?: unknown;
  document_order?: unknown;
  rendered?: unknown;
  intrinsic_width?: unknown;
  intrinsic_height?: unknown;
  representation?: { role?: unknown };
  discovered_at?: unknown;
  expires_at?: unknown;
  element_ref?: unknown;
  container_ref?: unknown;
}

interface RawAssetDiscoveryResult {
  browser_instance_id?: unknown;
  context_id?: unknown;
  document_id?: unknown;
  frame_identity?: unknown;
  snapshot_id?: unknown;
  assets?: unknown;
}

interface RawAssetAvailability {
  state?: unknown;
  reason?: unknown;
}

interface RawAssetCapabilitiesResult {
  discover?: RawAssetAvailability;
  read?: RawAssetAvailability;
}

interface RawAssetOpenResult {
  transfer_id?: unknown;
  asset_handle?: unknown;
  mime_type?: unknown;
  content_length?: unknown;
  next_sequence?: unknown;
  next_offset?: unknown;
  max_raw_chunk_bytes?: unknown;
  replay_window_chunks?: unknown;
  representation_binding?: unknown;
}

interface RawAssetTerminal {
  acquisition_bytes?: unknown;
  acquisition_sha256?: unknown;
}

interface RawAssetChunkResult {
  transfer_id?: unknown;
  sequence?: unknown;
  offset?: unknown;
  raw_bytes?: unknown;
  data_base64?: unknown;
  eof?: unknown;
  terminal?: RawAssetTerminal;
}

interface AssetTransferTracker {
  browserInstanceId: string;
  contextId: string;
  transferId: string;
  nextSequence: number;
  nextOffset: number;
  bytes: number;
  hash: Hash;
  terminal: boolean;
  last?: {
    sequence: number;
    offset: number;
    rawBytes: number;
    dataBase64: string;
    eof: boolean;
    terminalBytes?: number;
    terminalSha256?: string;
    mapped: BrowserAssetReadChunkResult;
  };
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

function assetErrorFromResponse(response: FirefoxBrokerResponse): Error {
  const message = response.error?.message || "Firefox asset provider request failed";
  return Object.assign(new Error(message), {
    code: response.error?.code || "BROWSER_ASSET_FETCH_FAILED",
    ...(response.error?.reason ? { reason: response.error.reason } : {}),
  });
}

function assertAssetOk(response: FirefoxBrokerResponse): unknown {
  if (!response.ok) throw assetErrorFromResponse(response);
  return response.result;
}

function assetMediaKind(value: unknown): "image" | "audio" | "video" {
  if (value === "image" || value === "audio" || value === "video") return value;
  throw Object.assign(new Error("Firefox asset discovery returned an invalid media kind"), {
    code: "BROWSER_ASSET_FETCH_FAILED",
    reason: "invalid_discovery_media_kind",
  });
}

function assetRepresentationRole(value: unknown): "original" | "preview" | "thumbnail" | "unknown" {
  if (value === "original" || value === "preview" || value === "thumbnail") return value;
  return "unknown";
}

function assetAvailability(raw: RawAssetAvailability | undefined): { state: "ready" } | { state: "unsupported" | "unavailable"; reason: string } {
  if (raw?.state === "ready") return { state: "ready" };
  if (raw?.state === "unsupported") return { state: "unsupported", reason: stringOrEmpty(raw.reason) || "unsupported" };
  return { state: "unavailable", reason: stringOrEmpty(raw?.reason) || "unavailable" };
}

function assetProtocolError(reason: string, message = "Firefox asset transfer protocol validation failed"): Error {
  return Object.assign(new Error(message), {
    code: "BROWSER_ASSET_TRANSFER_PROTOCOL",
    reason,
  });
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
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

export class FirefoxBrowserProvider implements BrowserProvider, BrowserAssetProviderV1 {
  readonly protocolVersion = BROWSER_PROVIDER_V1;
  readonly assetProtocolVersion = BROWSER_ASSET_PROVIDER_V1;
  readonly #browserInstanceId: string | undefined;
  readonly #sessionMaxAgeMs: number | undefined;
  readonly #sessionsDir: string | undefined;
  readonly #assetTransfers = new Map<string, AssetTransferTracker>();

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

  async #closeAssetHandleBestEffort(
    assetHandle: string,
    tracker: AssetTransferTracker,
    reason: BrowserAssetCloseRequest["reason"] = "consumer_error",
  ): Promise<void> {
    this.#assetTransfers.delete(assetHandle);
    try {
      const session = this.#sessionFor(tracker.browserInstanceId);
      await sendFirefoxBrokerRequest(
        session,
        "asset_close_v1",
        { asset_handle: assetHandle, reason },
        {},
      );
    } catch {
      // Best-effort cleanup after a protocol failure. The browser-side handle is also TTL-bound.
    }
  }

  async #failAssetTransfer(
    assetHandle: string,
    tracker: AssetTransferTracker,
    reason: string,
  ): Promise<never> {
    await this.#closeAssetHandleBestEffort(assetHandle, tracker, "consumer_error");
    throw assetProtocolError(reason);
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

  async assetCapabilities(
    request: { browserInstanceId: string; contextId: string },
    options: BrowserOperationOptions = {},
  ): Promise<BrowserAssetContextCapabilities> {
    const session = this.#sessionFor(request.browserInstanceId);
    const response = await sendFirefoxBrokerRequest(
      session,
      "asset_capabilities_v1",
      { context_id: request.contextId },
      brokerOptions(options),
    );
    const raw = assertAssetOk(response) as RawAssetCapabilitiesResult;
    return {
      protocolVersion: BROWSER_ASSET_PROVIDER_V1,
      discover: assetAvailability(raw.discover),
      read: assetAvailability(raw.read),
      maxRawChunkBytes: BROWSER_ASSET_PROVIDER_V1_MAX_RAW_CHUNK_BYTES,
      replayWindowChunks: BROWSER_ASSET_PROVIDER_V1_REPLAY_WINDOW_CHUNKS,
    };
  }

  async discoverAssets(
    request: BrowserAssetDiscoveryRequest,
    options: BrowserOperationOptions = {},
  ): Promise<BrowserAssetDiscovery> {
    const session = this.#sessionFor(request.browserInstanceId);
    const response = await sendFirefoxBrokerRequest(
      session,
      "asset_discover_v1",
      {
        context_id: request.contextId,
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      },
      brokerOptions(options),
    );
    const raw = assertAssetOk(response) as RawAssetDiscoveryResult;
    const browserInstanceId = stringOrEmpty(raw.browser_instance_id) || request.browserInstanceId;
    const contextId = stringOrEmpty(raw.context_id) || request.contextId;
    const documentId = stringOrEmpty(raw.document_id);
    const frameId = stringOrEmpty(raw.frame_identity) || "top";
    const snapshotId = nullableString(raw.snapshot_id) ?? undefined;
    const assets = Array.isArray(raw.assets) ? raw.assets as RawAssetDiscoveryAsset[] : [];
    return {
      protocolVersion: BROWSER_ASSET_PROVIDER_V1,
      browserInstanceId,
      contextId,
      documentId,
      assets: assets.map((asset, index) => {
        const width = nullableNumber(asset.intrinsic_width);
        const height = nullableNumber(asset.intrinsic_height);
        const discoveredAt = nullableNumber(asset.discovered_at) ?? 0;
        const expiresAt = nullableNumber(asset.expires_at) ?? discoveredAt;
        return {
          assetRef: stringOrEmpty(asset.asset_ref),
          browserInstanceId,
          contextId,
          documentId,
          frameId,
          ...(snapshotId ? { snapshotId } : {}),
          ...(typeof asset.element_ref === "string" ? { elementRef: asset.element_ref } : {}),
          ...(typeof asset.container_ref === "string" ? { containerRef: asset.container_ref } : {}),
          ...(typeof asset.safe_label === "string" ? { safeLabel: asset.safe_label } : {}),
          documentOrder: nullableNumber(asset.document_order) ?? index,
          mediaKind: assetMediaKind(asset.media_kind),
          rendered: asset.rendered === true,
          ...(width !== null && height !== null && width > 0 && height > 0
            ? { intrinsicDimensions: { width, height } }
            : {}),
          representation: { role: assetRepresentationRole(asset.representation?.role) },
          discoveredAt,
          expiresAt,
        };
      }),
    };
  }

  async openAsset(
    request: BrowserAssetOpenRequest,
    options: BrowserOperationOptions = {},
  ): Promise<BrowserAssetOpenResult> {
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
      throw assetProtocolError("invalid_max_bytes");
    }
    const session = this.#sessionFor(request.browserInstanceId);
    const response = await sendFirefoxBrokerRequest(
      session,
      "asset_open_v1",
      {
        context_id: request.contextId,
        asset_ref: request.assetRef,
        max_bytes: request.maxBytes,
      },
      brokerOptions(options),
    );
    const raw = assertAssetOk(response) as RawAssetOpenResult;
    const transferId = stringOrEmpty(raw.transfer_id);
    const assetHandle = stringOrEmpty(raw.asset_handle);
    const contentLength = raw.content_length === null ? null : nonNegativeSafeInteger(raw.content_length);
    const nextSequence = nonNegativeSafeInteger(raw.next_sequence);
    const nextOffset = nonNegativeSafeInteger(raw.next_offset);
    const maxRawChunkBytes = nonNegativeSafeInteger(raw.max_raw_chunk_bytes);
    const replayWindowChunks = nonNegativeSafeInteger(raw.replay_window_chunks);
    const representationBinding = raw.representation_binding === "response-identity-proven"
      ? "response-identity-proven"
      : raw.representation_binding === "source-revalidated"
        ? "source-revalidated"
        : null;
    const failOpen = async (reason: string): Promise<never> => {
      if (assetHandle) {
        try {
          await sendFirefoxBrokerRequest(
            session,
            "asset_close_v1",
            { asset_handle: assetHandle, reason: "consumer_error" },
            brokerOptions(options),
          );
        } catch {
          // Best-effort cleanup when the open handshake itself is malformed.
        }
      }
      throw assetProtocolError(reason);
    };
    if (!transferId || !assetHandle) return failOpen("missing_transfer_identity");
    if (raw.content_length !== null && contentLength === null) return failOpen("invalid_content_length");
    if (nextSequence !== 0 || nextOffset !== 0) return failOpen("invalid_initial_position");
    if (maxRawChunkBytes !== BROWSER_ASSET_PROVIDER_V1_MAX_RAW_CHUNK_BYTES) return failOpen("chunk_ceiling_mismatch");
    if (replayWindowChunks !== BROWSER_ASSET_PROVIDER_V1_REPLAY_WINDOW_CHUNKS) return failOpen("replay_window_mismatch");
    if (!representationBinding) return failOpen("invalid_representation_binding");

    this.#assetTransfers.set(assetHandle, {
      browserInstanceId: request.browserInstanceId,
      contextId: request.contextId,
      transferId,
      nextSequence: 0,
      nextOffset: 0,
      bytes: 0,
      hash: createHash("sha256"),
      terminal: false,
    });
    return {
      protocolVersion: BROWSER_ASSET_PROVIDER_V1,
      transferId,
      assetHandle,
      mimeType: stringOrEmpty(raw.mime_type) || "application/octet-stream",
      contentLength,
      nextSequence: 0,
      nextOffset: 0,
      maxRawChunkBytes: BROWSER_ASSET_PROVIDER_V1_MAX_RAW_CHUNK_BYTES,
      replayWindowChunks: BROWSER_ASSET_PROVIDER_V1_REPLAY_WINDOW_CHUNKS,
      representationBinding,
    };
  }

  async readAssetChunk(
    request: BrowserAssetReadChunkRequest,
    options: BrowserOperationOptions = {},
  ): Promise<BrowserAssetReadChunkResult> {
    const tracker = this.#assetTransfers.get(request.assetHandle);
    if (!tracker) throw assetProtocolError("asset_handle_unknown_or_expired");
    if (!Number.isSafeInteger(request.maxRawBytes) || request.maxRawBytes <= 0
      || request.maxRawBytes > BROWSER_ASSET_PROVIDER_V1_MAX_RAW_CHUNK_BYTES) {
      return this.#failAssetTransfer(request.assetHandle, tracker, "invalid_max_raw_bytes");
    }
    const replay = tracker.last
      && request.sequence === tracker.last.sequence
      && request.offset === tracker.last.offset;
    if (!replay && (tracker.terminal
      || request.sequence !== tracker.nextSequence
      || request.offset !== tracker.nextOffset)) {
      return this.#failAssetTransfer(request.assetHandle, tracker, "sequence_or_offset_mismatch");
    }

    const session = this.#sessionFor(tracker.browserInstanceId);
    const response = await sendFirefoxBrokerRequest(
      session,
      "asset_read_chunk_v1",
      {
        asset_handle: request.assetHandle,
        sequence: request.sequence,
        offset: request.offset,
        max_raw_bytes: request.maxRawBytes,
      },
      brokerOptions(options),
    );
    const raw = assertAssetOk(response) as RawAssetChunkResult;
    const transferId = stringOrEmpty(raw.transfer_id);
    const sequence = nonNegativeSafeInteger(raw.sequence);
    const offset = nonNegativeSafeInteger(raw.offset);
    const rawBytes = nonNegativeSafeInteger(raw.raw_bytes);
    const dataBase64 = stringOrEmpty(raw.data_base64);
    if (transferId !== tracker.transferId) return this.#failAssetTransfer(request.assetHandle, tracker, "transfer_id_mismatch");
    if (sequence !== request.sequence || offset !== request.offset) return this.#failAssetTransfer(request.assetHandle, tracker, "response_position_mismatch");
    if (rawBytes === null || rawBytes > request.maxRawBytes || rawBytes > BROWSER_ASSET_PROVIDER_V1_MAX_RAW_CHUNK_BYTES) {
      return this.#failAssetTransfer(request.assetHandle, tracker, "invalid_raw_byte_count");
    }
    if (raw.eof !== true && raw.eof !== false) return this.#failAssetTransfer(request.assetHandle, tracker, "invalid_eof_flag");
    const decoded = Buffer.from(dataBase64, "base64");
    if (decoded.byteLength !== rawBytes) return this.#failAssetTransfer(request.assetHandle, tracker, "base64_raw_byte_mismatch");

    const terminalBytes = raw.eof === true ? nonNegativeSafeInteger(raw.terminal?.acquisition_bytes) : undefined;
    const terminalSha256 = raw.eof === true ? stringOrEmpty(raw.terminal?.acquisition_sha256).toLowerCase() : undefined;
    if (raw.eof === true && (terminalBytes === null || !/^[a-f0-9]{64}$/.test(terminalSha256 || ""))) {
      return this.#failAssetTransfer(request.assetHandle, tracker, "invalid_terminal_record");
    }
    if (raw.eof === false && raw.terminal !== undefined) {
      return this.#failAssetTransfer(request.assetHandle, tracker, "terminal_before_eof");
    }

    const mapped: BrowserAssetReadChunkResult = raw.eof === true
      ? {
          transferId: tracker.transferId,
          sequence: request.sequence,
          offset: request.offset,
          rawBytes,
          dataBase64,
          eof: true,
          terminal: {
            acquisitionBytes: terminalBytes!,
            acquisitionSha256: terminalSha256!,
          },
        }
      : {
          transferId: tracker.transferId,
          sequence: request.sequence,
          offset: request.offset,
          rawBytes,
          dataBase64,
          eof: false,
        };

    if (replay) {
      const last = tracker.last!;
      if (last.rawBytes !== rawBytes
        || last.dataBase64 !== dataBase64
        || last.eof !== raw.eof
        || last.terminalBytes !== terminalBytes
        || last.terminalSha256 !== terminalSha256) {
        return this.#failAssetTransfer(request.assetHandle, tracker, "replay_not_byte_identical");
      }
      return last.mapped;
    }

    tracker.hash.update(decoded);
    tracker.bytes += rawBytes;
    tracker.nextSequence = request.sequence + 1;
    tracker.nextOffset = request.offset + rawBytes;
    if (raw.eof === true) {
      const consumerSha256 = tracker.hash.copy().digest("hex");
      if (terminalBytes !== tracker.bytes) return this.#failAssetTransfer(request.assetHandle, tracker, "terminal_byte_count_mismatch");
      if (terminalSha256 !== consumerSha256) return this.#failAssetTransfer(request.assetHandle, tracker, "terminal_digest_mismatch");
      tracker.terminal = true;
    }
    tracker.last = {
      sequence: request.sequence,
      offset: request.offset,
      rawBytes,
      dataBase64,
      eof: raw.eof,
      ...(terminalBytes == null ? {} : { terminalBytes }),
      ...(terminalSha256 === undefined ? {} : { terminalSha256 }),
      mapped,
    };
    return mapped;
  }

  async closeAsset(
    request: BrowserAssetCloseRequest,
    options: BrowserOperationOptions = {},
  ): Promise<BrowserAssetCloseResult> {
    const tracker = this.#assetTransfers.get(request.assetHandle);
    if (!tracker) return { closed: true };
    const session = this.#sessionFor(tracker.browserInstanceId);
    try {
      const response = await sendFirefoxBrokerRequest(
        session,
        "asset_close_v1",
        {
          asset_handle: request.assetHandle,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        },
        brokerOptions(options),
      );
      const raw = assertAssetOk(response) as { closed?: unknown };
      if (raw.closed !== true) throw assetProtocolError("close_not_acknowledged");
      return { closed: true };
    } finally {
      this.#assetTransfers.delete(request.assetHandle);
    }
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
    const active = [...this.#assetTransfers.entries()];
    await Promise.all(active.map(async ([assetHandle, tracker]) => {
      await this.#closeAssetHandleBestEffort(assetHandle, tracker, "consumer_abort");
    }));
    // Browser process, companion and native-host lifetime remain operator-owned.
  }

}

export function createFirefoxBrowserProvider(options: FirefoxBrowserProviderOptions = {}): FirefoxBrowserProvider {
  return new FirefoxBrowserProvider(options);
}

/** Standard dynamic-provider export consumed by @zamery/pi-browser. */
export const createBrowserProvider = createFirefoxBrowserProvider;
