export const FIREFOX_COMPANION_PRODUCTION_EXTENSION_ID = "zamery-browser-firefox@zamery.local";
export const FIREFOX_COMPANION_DEVELOPMENT_EXTENSION_ID = "zamery-live-browser-v0c@zamery.local";
export const FIREFOX_COMPANION_AUTH_STATUS_MESSAGE = "zamery_browser_firefox_auth_status";
export const FIREFOX_COMPANION_GRANT_MESSAGE = "zamery_browser_firefox_grant";
export const FIREFOX_COMPANION_REVOKE_MESSAGE = "zamery_browser_firefox_revoke";

export const FIREFOX_COMPANION_PROTOCOL_VERSION = 2 as const;
export const FIREFOX_COMPANION_AUTHORIZATION_FIXED_DAY_PRESETS = [1, 3, 7, 14, 30] as const;
export const FIREFOX_COMPANION_AUTHORIZATION_MAX_CUSTOM_DAYS = 30 as const;

export type FirefoxCompanionAuthorizationState = "granted" | "revoked" | "expired" | "rebind_required";

export interface FirefoxCompanionAuthorizationStatus {
  state: FirefoxCompanionAuthorizationState;
  reason?: string | null;
  current_host_session_id: string | null;
  granted_host_session_id: string | null;
  granted_at: number | null;
  expires_at: number | null;
  grant_revision?: number;
  audience_id?: string | null;
  duration_mode?: "session" | "fixed" | null;
  duration_days?: number | null;
  scope_kind?: "tabs" | "group" | null;
  scope_count?: number;
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
