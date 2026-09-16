import {
  BROWSER_PROVIDER_V2,
  type BrowserProviderV2,
} from "@zamery/browser-provider";

export function acceptsBrowserProviderV2(provider: BrowserProviderV2): boolean {
  return provider.protocolVersion === BROWSER_PROVIDER_V2;
}
