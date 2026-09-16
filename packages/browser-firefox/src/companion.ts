export const FIREFOX_COMPANION_PRODUCTION_EXTENSION_ID = "zamery-browser-firefox@zamery.local";
export const FIREFOX_COMPANION_DEVELOPMENT_EXTENSION_ID = "zamery-live-browser-v0c@zamery.local";
export const FIREFOX_COMPANION_AUTH_STATUS_MESSAGE = "zamery_browser_firefox_auth_status";
export const FIREFOX_COMPANION_GRANT_MESSAGE = "zamery_browser_firefox_grant";
export const FIREFOX_COMPANION_REVOKE_MESSAGE = "zamery_browser_firefox_revoke";

export const FIREFOX_COMPANION_PROTOCOL_VERSION = 1 as const;
export const FIREFOX_COMPANION_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;

export type FirefoxCompanionAuthorizationState = "granted" | "revoked";

export interface FirefoxCompanionAuthorizationStatus {
  state: FirefoxCompanionAuthorizationState;
  current_host_session_id: string | null;
  granted_host_session_id: string | null;
  granted_at: number | null;
  expires_at: number | null;
  expected_protocol_version: typeof FIREFOX_COMPANION_PROTOCOL_VERSION;
  current_host_protocol_version: number | null;
  protocol_compatible: boolean;
}

export interface FirefoxCompanionIdentityStrategy {
  productionExtensionId: string;
  developmentExtensionIds: readonly string[];
  signingStatus: "not-run" | "signed";
}

export const FIREFOX_COMPANION_IDENTITY_STRATEGY: FirefoxCompanionIdentityStrategy = {
  productionExtensionId: FIREFOX_COMPANION_PRODUCTION_EXTENSION_ID,
  developmentExtensionIds: [FIREFOX_COMPANION_DEVELOPMENT_EXTENSION_ID],
  signingStatus: "signed",
};
