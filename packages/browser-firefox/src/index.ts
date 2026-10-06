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
export { ArtifactError, ArtifactStore, defaultArtifactRoot } from "./artifact-store.js";
export { runFirefoxDoctor, formatDoctorReport, type DoctorReport, type DoctorFinding, type DoctorSession } from "./doctor.js";
export { firefoxCompatibilityFacts, FIREFOX_JOURNAL_SCHEMA_VERSION, FIREFOX_MIN_BROWSER_VERSION, type FirefoxCompatibilityFacts } from "./compat.js";
