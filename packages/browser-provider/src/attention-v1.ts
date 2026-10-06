import type { BrowserOperationOptionsV2, BrowserProviderSessionIdV2 } from "./v2.js";

/** Optional provider-neutral attention surface. Attention never grants or widens browser authority. */
export const BROWSER_ATTENTION_PROVIDER_V1 = 1 as const;

export type BrowserAttentionKindV1 = "access";

export interface BrowserAttentionTargetV1 {
  browserInstanceId: string;
  providerSessionId?: BrowserProviderSessionIdV2;
}

export interface BrowserAttentionRequestV1 extends BrowserAttentionTargetV1 {
  kind: BrowserAttentionKindV1;
}

export interface BrowserAttentionResultV1 {
  kind: BrowserAttentionKindV1;
  state: "requested" | "already_pending" | "not_needed";
  expiresAt: number | null;
}

export interface BrowserAttentionProviderV1 {
  readonly attentionProtocolVersion: typeof BROWSER_ATTENTION_PROVIDER_V1;
  requestAttention(
    request: BrowserAttentionRequestV1,
    options?: BrowserOperationOptionsV2,
  ): Promise<BrowserAttentionResultV1>;
}

export function isBrowserAttentionProviderV1(value: unknown): value is BrowserAttentionProviderV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrowserAttentionProviderV1>;
  return candidate.attentionProtocolVersion === BROWSER_ATTENTION_PROVIDER_V1
    && typeof candidate.requestAttention === "function";
}
