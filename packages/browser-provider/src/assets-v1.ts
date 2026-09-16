import type {
  BrowserContextId,
  BrowserElementRef,
  BrowserInstanceId,
  BrowserOperationOptions,
} from "./index.js";

/**
 * Frozen optional V1 contract for browser-backed asset acquisition.
 *
 * This remains deliberately separate from BrowserProvider V1. Exporting this interface does
 * not advertise that a provider implements asset acquisition, and none of these capability ids
 * are members of BROWSER_PROVIDER_V1_CAPABILITIES. A provider may advertise
 * `asset.read.browser-session-v1` only when it satisfies the frozen same-origin, redirect-refusal,
 * bounded-streaming, replay and terminal-integrity semantics.
 */
export const BROWSER_ASSET_PROVIDER_V1 = 1 as const;

export const BROWSER_ASSET_PROVIDER_V1_CAPABILITIES = [
  "asset.discover.dom-v1",
  "asset.read.browser-session-v1",
] as const;

/** A1-calibrated hard ceiling for one raw chunk before base64 encoding. */
export const BROWSER_ASSET_PROVIDER_V1_MAX_RAW_CHUNK_BYTES = 128 * 1024;
/** V1 retains exactly the current chunk for byte-identical lost-response replay. */
export const BROWSER_ASSET_PROVIDER_V1_REPLAY_WINDOW_CHUNKS = 1 as const;
export const BROWSER_ASSET_SAFE_LABEL_MAX_CHARS = 240;

export type BrowserAssetCapabilityId =
  (typeof BROWSER_ASSET_PROVIDER_V1_CAPABILITIES)[number];

export type BrowserAssetRef = string;
export type BrowserAssetHandle = string;
export type BrowserAssetTransferId = string;

export type BrowserAssetMediaKind = "image" | "audio" | "video";
export type BrowserAssetRepresentationRole = "original" | "preview" | "thumbnail" | "unknown";
export type BrowserAssetRepresentationBinding = "source-revalidated" | "response-identity-proven";

export type BrowserAssetCapabilityAvailability =
  | { state: "ready" }
  | { state: "unsupported"; reason: string }
  | { state: "unavailable"; reason: string };

export interface BrowserAssetContextCapabilities {
  protocolVersion: typeof BROWSER_ASSET_PROVIDER_V1;
  discover: BrowserAssetCapabilityAvailability;
  read: BrowserAssetCapabilityAvailability;
  maxRawChunkBytes: typeof BROWSER_ASSET_PROVIDER_V1_MAX_RAW_CHUNK_BYTES;
  replayWindowChunks: typeof BROWSER_ASSET_PROVIDER_V1_REPLAY_WINDOW_CHUNKS;
}

export interface BrowserAssetIntrinsicDimensions {
  width: number;
  height: number;
}

/**
 * Safe discovery metadata only. Sensitive source URLs/currentSrc values stay inside the
 * provider-owned asset registry and are intentionally absent from this shape.
 */
export interface BrowserAssetDescriptor {
  assetRef: BrowserAssetRef;
  browserInstanceId: BrowserInstanceId;
  contextId: BrowserContextId;
  documentId: string;
  frameId: string;
  snapshotId?: string;
  elementRef?: BrowserElementRef;
  containerRef?: BrowserElementRef;
  safeLabel?: string;
  documentOrder: number;
  mediaKind: BrowserAssetMediaKind;
  rendered: boolean;
  intrinsicDimensions?: BrowserAssetIntrinsicDimensions;
  representation: {
    role: BrowserAssetRepresentationRole;
  };
  discoveredAt: number;
  expiresAt: number;
}

export interface BrowserAssetDiscoveryRequest {
  browserInstanceId: BrowserInstanceId;
  contextId: BrowserContextId;
  limit?: number;
}

export interface BrowserAssetDiscovery {
  protocolVersion: typeof BROWSER_ASSET_PROVIDER_V1;
  browserInstanceId: BrowserInstanceId;
  contextId: BrowserContextId;
  documentId: string;
  assets: readonly BrowserAssetDescriptor[];
}

export interface BrowserAssetOpenRequest {
  browserInstanceId: BrowserInstanceId;
  contextId: BrowserContextId;
  assetRef: BrowserAssetRef;
  /** Consumer hard limit for the whole acquisition, in raw bytes. */
  maxBytes: number;
}

export interface BrowserAssetOpenResult {
  protocolVersion: typeof BROWSER_ASSET_PROVIDER_V1;
  transferId: BrowserAssetTransferId;
  assetHandle: BrowserAssetHandle;
  mimeType: string;
  contentLength: number | null;
  nextSequence: 0;
  nextOffset: 0;
  maxRawChunkBytes: typeof BROWSER_ASSET_PROVIDER_V1_MAX_RAW_CHUNK_BYTES;
  replayWindowChunks: typeof BROWSER_ASSET_PROVIDER_V1_REPLAY_WINDOW_CHUNKS;
  representationBinding: BrowserAssetRepresentationBinding;
}

export interface BrowserAssetReadChunkRequest {
  assetHandle: BrowserAssetHandle;
  /** Monotonic sequence. Repeating the current sequence+offset must replay the same chunk. */
  sequence: number;
  /** Cumulative raw bytes acknowledged before this chunk. */
  offset: number;
  /** Must be <= BROWSER_ASSET_PROVIDER_V1_MAX_RAW_CHUNK_BYTES. */
  maxRawBytes: number;
}

interface BrowserAssetChunkBase {
  transferId: BrowserAssetTransferId;
  sequence: number;
  offset: number;
  rawBytes: number;
  dataBase64: string;
}

export interface BrowserAssetChunk extends BrowserAssetChunkBase {
  eof: false;
  terminal?: never;
}

export interface BrowserAssetTerminalRecord {
  acquisitionBytes: number;
  acquisitionSha256: string;
}

export interface BrowserAssetTerminalChunk extends BrowserAssetChunkBase {
  eof: true;
  terminal: BrowserAssetTerminalRecord;
}

export type BrowserAssetReadChunkResult = BrowserAssetChunk | BrowserAssetTerminalChunk;

export interface BrowserAssetCloseRequest {
  assetHandle: BrowserAssetHandle;
  reason?: "completed" | "consumer_abort" | "consumer_error" | "timeout";
}

export interface BrowserAssetCloseResult {
  closed: true;
}

export type BrowserAssetProviderErrorCode =
  | "BROWSER_ASSET_REF_UNKNOWN"
  | "BROWSER_ASSET_REF_EXPIRED"
  | "BROWSER_ASSET_STALE"
  | "BROWSER_ASSET_CROSS_ORIGIN_REFUSED"
  | "BROWSER_ASSET_SCHEME_REFUSED"
  | "BROWSER_ASSET_FETCH_FAILED"
  | "BROWSER_ASSET_AUTHORIZATION_REQUIRED"
  | "BROWSER_ASSET_SIZE_LIMIT"
  | "BROWSER_ASSET_TIMEOUT"
  | "BROWSER_ASSET_ABORTED"
  | "BROWSER_ASSET_TRANSFER_PROTOCOL"
  | "BROWSER_CONTEXT_GONE";

export interface BrowserAssetProviderError {
  code: BrowserAssetProviderErrorCode;
  message: string;
  reason?: string;
}

export interface BrowserAssetProviderV1 {
  readonly assetProtocolVersion: typeof BROWSER_ASSET_PROVIDER_V1;

  assetCapabilities(
    request: { browserInstanceId: BrowserInstanceId; contextId: BrowserContextId },
    options?: BrowserOperationOptions,
  ): Promise<BrowserAssetContextCapabilities>;

  discoverAssets(
    request: BrowserAssetDiscoveryRequest,
    options?: BrowserOperationOptions,
  ): Promise<BrowserAssetDiscovery>;

  openAsset(
    request: BrowserAssetOpenRequest,
    options?: BrowserOperationOptions,
  ): Promise<BrowserAssetOpenResult>;

  readAssetChunk(
    request: BrowserAssetReadChunkRequest,
    options?: BrowserOperationOptions,
  ): Promise<BrowserAssetReadChunkResult>;

  closeAsset(
    request: BrowserAssetCloseRequest,
    options?: BrowserOperationOptions,
  ): Promise<BrowserAssetCloseResult>;
}

export class BrowserAssetTransferProtocolError extends Error {
  readonly code = "BROWSER_ASSET_TRANSFER_PROTOCOL" as const;

  constructor(message: string) {
    super(message);
    this.name = "BrowserAssetTransferProtocolError";
  }
}

function base64DecodedLength(value: string): number {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new BrowserAssetTransferProtocolError("chunk data_base64 is not canonical base64");
  }
  const firstPadding = value.indexOf("=");
  if (firstPadding !== -1 && firstPadding < value.length - 2) {
    throw new BrowserAssetTransferProtocolError("chunk data_base64 has invalid padding");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export interface BrowserAssetChunkExpectation {
  transferId: BrowserAssetTransferId;
  sequence: number;
  offset: number;
  maxRawBytes: number;
}

/**
 * Consumer-side structural guard for the frozen V1 sequence/offset/terminal protocol.
 * Digest comparison against bytes already written remains the materializer's responsibility.
 */
export function assertBrowserAssetChunkEnvelope(
  expected: BrowserAssetChunkExpectation,
  chunk: BrowserAssetReadChunkResult,
): void {
  if (chunk.transferId !== expected.transferId) {
    throw new BrowserAssetTransferProtocolError("chunk transfer_id does not match the open transfer");
  }
  if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence !== expected.sequence) {
    throw new BrowserAssetTransferProtocolError("chunk sequence is not the expected sequence");
  }
  if (!Number.isSafeInteger(chunk.offset) || chunk.offset !== expected.offset) {
    throw new BrowserAssetTransferProtocolError("chunk offset is not the expected offset");
  }
  if (!Number.isSafeInteger(expected.maxRawBytes)
    || expected.maxRawBytes <= 0
    || expected.maxRawBytes > BROWSER_ASSET_PROVIDER_V1_MAX_RAW_CHUNK_BYTES) {
    throw new BrowserAssetTransferProtocolError(
      "expected max_raw_bytes must be a positive safe integer within the V1 hard ceiling",
    );
  }
  if (!Number.isSafeInteger(chunk.rawBytes) || chunk.rawBytes < 0 || chunk.rawBytes > expected.maxRawBytes) {
    throw new BrowserAssetTransferProtocolError("chunk raw_bytes is outside the requested bound");
  }
  const decodedLength = base64DecodedLength(chunk.dataBase64);
  if (decodedLength !== chunk.rawBytes) {
    throw new BrowserAssetTransferProtocolError("chunk raw_bytes does not match decoded payload length");
  }
  if (!chunk.eof && chunk.rawBytes === 0) {
    throw new BrowserAssetTransferProtocolError("non-terminal chunk must make forward progress");
  }
  if (chunk.eof) {
    const total = chunk.offset + chunk.rawBytes;
    if (!Number.isSafeInteger(chunk.terminal.acquisitionBytes)
      || chunk.terminal.acquisitionBytes !== total) {
      throw new BrowserAssetTransferProtocolError(
        "terminal acquisition_bytes does not equal offset plus final raw_bytes",
      );
    }
    if (!/^[a-f0-9]{64}$/i.test(chunk.terminal.acquisitionSha256)) {
      throw new BrowserAssetTransferProtocolError("terminal acquisition_sha256 is not a SHA-256 digest");
    }
  }
}
