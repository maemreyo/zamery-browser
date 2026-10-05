export {
  FirefoxBrowserProvider,
  createBrowserProvider,
  createFirefoxBrowserProvider,
  type FirefoxBrowserProviderOptions,
} from "./provider.js";
export {
  FirefoxBrowserProviderV2,
  controlErrorFrom,
  createBrowserProviderV2,
  createFirefoxBrowserProviderV2,
  createFirefoxRequestId,
} from "./provider-v2.js";
export { FirefoxBrokerTransportError, isFirefoxBrokerTransportError } from "./client.js";
export {
  DEFAULT_FIREFOX_NATIVE_HOST_NAME,
  buildFirefoxNativeHostInstallPlan,
  installFirefoxNativeHost,
  type FirefoxNativeHostInstallPlan,
} from "./install.js";
