export const FIREFOX_BROKER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_FIREFOX_SESSION_MAX_AGE_MS = 15_000;
export const DEFAULT_FIREFOX_BROKER_TIMEOUT_MS = 40_000;

export interface FirefoxSessionReceipt {
  protocol_version: typeof FIREFOX_BROKER_PROTOCOL_VERSION;
  session_id: string;
  socket_path: string;
  host_pid: number;
  started_at: number;
  last_heartbeat_at: number;
  profile_id: string | null;
  browser_instance_id: string | null;
  extension_id: string | null;
  extension_version: string | null;
  active_context_id?: string | null;
}

export interface FirefoxBrokerRequest {
  id: string;
  op: string;
  params?: Record<string, unknown>;
}

export interface FirefoxBrokerResponse {
  type?: string;
  id: string;
  replayed?: boolean;
  ok: boolean;
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
    reason?: string;
  };
  outcome?: "not_started" | "completed" | "partially_applied" | "outcome_unknown";
}
