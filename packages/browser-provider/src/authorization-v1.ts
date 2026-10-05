import type { BrowserControlStateV1, BrowserControlTargetV1 } from "./control-v1.js";
import type { BrowserOperationOptionsV2 } from "./v2.js";

/**
 * Optional BrowserAuthorizationProviderV1: richer, read-only access status than BrowserAuthorizationStatusV2.
 *
 * V2 keeps its `granted | revoked | not-required` summary. This interface adds expiry, scope and
 * restart semantics without changing what those V2 values mean. It cannot grant: the user does that
 * in the browser.
 */
export const BROWSER_AUTHORIZATION_PROVIDER_V1 = 1 as const;

export type BrowserAuthorizationStateV1 =
  | "granted"
  | "revoked"
  | "expired"
  | "rebind_required"
  | "protocol_mismatch"
  | "disconnected";

export type BrowserAuthorizationActionV1 =
  | "inspect"
  | "interact"
  | "capture"
  | "reorganize"
  | "create_tab"
  | "close_owned_tab";

export interface BrowserAuthorizationDetailV1 {
  protocolVersion: typeof BROWSER_AUTHORIZATION_PROVIDER_V1;
  state: BrowserAuthorizationStateV1;
  /** Why access is not granted, e.g. `user_revoked`, `authorization_expired`, `restart`, `bound_to_other_consumer`. */
  reason: string | null;
  grantRevision: number;
  /** `session` ends with the live host session; `fixed` keeps its deadline across restarts but needs explicit rebind. */
  mode: "session" | "fixed" | null;
  durationDays: number | null;
  issuedAt: number | null;
  expiresAt: number | null;
  scope: { kind: "tabs" | "group" | null; count: number };
  actions: readonly BrowserAuthorizationActionV1[];
  groupPolicy: "membership_snapshot" | "follow_group" | null;
  restartPolicy: "explicit_rebind";
  protocolCompatible: boolean;
  control: BrowserControlStateV1;
  /** Firefox/companion specifics that help setup guidance; never page data. */
  companion?: { version: string | null; featureFlags: Readonly<Record<string, boolean>> };
}

export interface BrowserAuthorizationProviderV1 {
  readonly authorizationProtocolVersion: typeof BROWSER_AUTHORIZATION_PROVIDER_V1;
  authorizationDetail(
    request?: Partial<BrowserControlTargetV1>,
    options?: BrowserOperationOptionsV2,
  ): Promise<BrowserAuthorizationDetailV1>;
}

export function isBrowserAuthorizationProviderV1(value: unknown): value is BrowserAuthorizationProviderV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrowserAuthorizationProviderV1>;
  return candidate.authorizationProtocolVersion === BROWSER_AUTHORIZATION_PROVIDER_V1
    && typeof candidate.authorizationDetail === "function";
}
