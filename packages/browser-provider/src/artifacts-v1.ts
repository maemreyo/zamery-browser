import type { BrowserControlResultV1, BrowserControlTargetV1 } from "./control-v1.js";
import type { BrowserOperationOptionsV2 } from "./v2.js";

/**
 * Optional BrowserArtifactProviderV1: bounded screenshots delivered as managed, immutable artifacts.
 *
 * An artifact is evidence of what was captured, not proof of the current page. Bytes are bounded,
 * integrity-checked and audience-scoped; callers never supply filesystem paths.
 */
export const BROWSER_ARTIFACT_PROVIDER_V1 = 1 as const;

export const BROWSER_ARTIFACT_LIMITS_V1 = {
  /** Output pixels (after scale). Product ceiling, not a Firefox guarantee. */
  maxPixels: 8_000_000,
  maxSideLength: 4096,
  maxEncodedBytes: 8 * 1024 * 1024,
  /** Raw bytes per transport chunk before base64. */
  maxChunkRawBytes: 64 * 1024,
  defaultLifetimeMs: 30 * 60 * 1000,
  maxAudienceBytes: 64 * 1024 * 1024,
} as const;

export type BrowserArtifactMediaTypeV1 = "image/png" | "image/jpeg";

export interface BrowserScreenshotRectV1 {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserScreenshotRequestV1 extends BrowserControlTargetV1 {
  requestId: string;
  contextId: string;
  /** Page-relative CSS pixels. Required: a bounded rectangle makes the work bounded. */
  rect: BrowserScreenshotRectV1;
  /** (0, 1]. Default 1. */
  scale?: number;
  format?: "png" | "jpeg";
  /** 1..100, jpeg only. */
  quality?: number;
}

export interface BrowserArtifactDescriptorV1 {
  artifactId: string;
  kind: "screenshot";
  mediaType: BrowserArtifactMediaTypeV1;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  contextId: string;
  /** Document the pixels came from. A later navigation makes this historical, not current. */
  documentId: string | null;
  grantRevision: number;
  createdAt: number;
  expiresAt: number;
}

export interface BrowserArtifactBytesV1 {
  descriptor: BrowserArtifactDescriptorV1;
  data: Uint8Array;
}

export interface BrowserArtifactProviderV1 {
  readonly artifactProtocolVersion: typeof BROWSER_ARTIFACT_PROVIDER_V1;
  screenshot(
    request: BrowserScreenshotRequestV1,
    options?: BrowserOperationOptionsV2,
  ): Promise<BrowserControlResultV1<BrowserArtifactDescriptorV1>>;
  describeArtifact(artifactId: string): Promise<BrowserArtifactDescriptorV1>;
  /** Verifies scope, expiry and digest before returning bytes. Throws a coded error on any failure. */
  readArtifact(artifactId: string, options?: BrowserOperationOptionsV2): Promise<BrowserArtifactBytesV1>;
  closeArtifact(artifactId: string): Promise<void>;
}

export function isBrowserArtifactProviderV1(value: unknown): value is BrowserArtifactProviderV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrowserArtifactProviderV1>;
  return candidate.artifactProtocolVersion === BROWSER_ARTIFACT_PROVIDER_V1
    && typeof candidate.screenshot === "function"
    && typeof candidate.describeArtifact === "function"
    && typeof candidate.readArtifact === "function"
    && typeof candidate.closeArtifact === "function";
}
