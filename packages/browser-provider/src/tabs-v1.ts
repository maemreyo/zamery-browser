import type {
  BrowserControlResultV1,
  BrowserControlTargetV1,
} from "./control-v1.js";
import type { BrowserOperationOptionsV2 } from "./v2.js";

/**
 * Optional BrowserTabProviderV1: lifecycle operations for tabs the provider created ("owned") and
 * navigation/activation of authorized tabs. Every mutation carries a stable `requestId` and returns a
 * `browser-control` receipt, never a DOM-action receipt.
 */
export const BROWSER_TAB_PROVIDER_V1 = 1 as const;

export const BROWSER_TAB_PROVIDER_V1_CAPABILITIES = [
  "tab.create",
  "tab.navigate",
  "tab.reload",
  "tab.activate",
  "tab.close-owned",
] as const;

export type BrowserTabCapabilityIdV1 = (typeof BROWSER_TAB_PROVIDER_V1_CAPABILITIES)[number];

export interface BrowserTabMutationBaseV1 extends BrowserControlTargetV1 {
  requestId: string;
}

export interface BrowserTabCreateRequestV1 extends BrowserTabMutationBaseV1 {
  /** http(s) destination. Other schemes are refused. */
  url: string;
  /** Default false: do not steal focus from the user. */
  active?: boolean;
}

export interface BrowserTabContextRequestV1 extends BrowserTabMutationBaseV1 {
  contextId: string;
}

export interface BrowserTabNavigateRequestV1 extends BrowserTabContextRequestV1 {
  url: string;
}

export interface BrowserTabValueV1 {
  contextId: string;
  ownership: "provider-owned" | "user-owned";
}

export interface BrowserTabProviderV1 {
  readonly tabProtocolVersion: typeof BROWSER_TAB_PROVIDER_V1;
  tabCapabilities(request: BrowserControlTargetV1, options?: BrowserOperationOptionsV2): Promise<readonly BrowserTabCapabilityIdV1[]>;
  createTab(request: BrowserTabCreateRequestV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlResultV1<BrowserTabValueV1>>;
  navigateTab(request: BrowserTabNavigateRequestV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlResultV1<BrowserTabValueV1>>;
  reloadTab(request: BrowserTabContextRequestV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlResultV1<BrowserTabValueV1>>;
  activateTab(request: BrowserTabContextRequestV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlResultV1<BrowserTabValueV1>>;
  closeOwnedTab(request: BrowserTabContextRequestV1, options?: BrowserOperationOptionsV2): Promise<BrowserControlResultV1<undefined>>;
}

export function isBrowserTabProviderV1(value: unknown): value is BrowserTabProviderV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrowserTabProviderV1>;
  return candidate.tabProtocolVersion === BROWSER_TAB_PROVIDER_V1
    && typeof candidate.tabCapabilities === "function"
    && typeof candidate.createTab === "function"
    && typeof candidate.navigateTab === "function"
    && typeof candidate.reloadTab === "function"
    && typeof candidate.activateTab === "function"
    && typeof candidate.closeOwnedTab === "function";
}
