import crypto from "node:crypto";
import net from "node:net";

import {
  DEFAULT_FIREFOX_BROKER_TIMEOUT_MS,
  MAX_FIREFOX_BROKER_RESPONSE_LINE_BYTES,
  type FirefoxBrokerRequest,
  type FirefoxBrokerResponse,
  type FirefoxSessionReceipt,
} from "./protocol.js";

export interface SendFirefoxBrokerRequestOptions {
  id?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  audienceId?: string;
  /**
   * Bounded retry for idempotent reads only. Never set this for a mutation: a lost response after
   * dispatch must be reconciled through mutation status, not blindly re-sent.
   */
  readRetry?: { attempts: number; backoffMs: number };
}

/** Where a transport failure happened relative to the request reaching the broker. */
export type FirefoxBrokerTransportPhase = "not_dispatched" | "dispatch_unknown";

export class FirefoxBrokerTransportError extends Error {
  readonly phase: FirefoxBrokerTransportPhase;
  readonly transportCode: "CONNECT_FAILED" | "TIMEOUT" | "CLOSED_EARLY" | "FRAME_TOO_LARGE" | "BAD_FRAME";

  constructor(
    message: string,
    phase: FirefoxBrokerTransportPhase,
    transportCode: FirefoxBrokerTransportError["transportCode"],
  ) {
    super(message);
    this.name = "FirefoxBrokerTransportError";
    this.phase = phase;
    this.transportCode = transportCode;
  }
}

export function isFirefoxBrokerTransportError(value: unknown): value is FirefoxBrokerTransportError {
  return value instanceof FirefoxBrokerTransportError;
}

function exchange(
  session: FirefoxSessionReceipt,
  request: FirefoxBrokerRequest,
  timeoutMs: number,
): Promise<FirefoxBrokerResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(session.socket_path);
    let buffer = "";
    let settled = false;
    let dispatched = false;
    const phase = (): FirefoxBrokerTransportPhase => (dispatched ? "dispatch_unknown" : "not_dispatched");
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new FirefoxBrokerTransportError(`Firefox broker response timeout after ${timeoutMs}ms`, phase(), "TIMEOUT"));
    }, timeoutMs);

    const cleanup = () => clearTimeout(timer);
    const rejectPrematureClose = (event: "ended" | "closed") => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new FirefoxBrokerTransportError(
        `Firefox broker connection ${event} before a complete response frame`,
        phase(),
        "CLOSED_EARLY",
      ));
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      dispatched = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FIREFOX_BROKER_RESPONSE_LINE_BYTES) {
        settled = true;
        cleanup();
        socket.destroy();
        reject(new FirefoxBrokerTransportError(
          `Firefox broker response exceeds ${MAX_FIREFOX_BROKER_RESPONSE_LINE_BYTES} bytes`,
          "dispatch_unknown",
          "FRAME_TOO_LARGE",
        ));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      settled = true;
      cleanup();
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as FirefoxBrokerResponse);
      } catch {
        reject(new FirefoxBrokerTransportError("Firefox broker returned a malformed frame", "dispatch_unknown", "BAD_FRAME"));
      }
    });
    socket.on("end", () => rejectPrematureClose("ended"));
    socket.on("close", () => rejectPrematureClose("closed"));
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new FirefoxBrokerTransportError(
        `Firefox broker transport error: ${error.message}`,
        phase(),
        dispatched ? "CLOSED_EARLY" : "CONNECT_FAILED",
      ));
    });
  });
}

export async function sendFirefoxBrokerRequest(
  session: FirefoxSessionReceipt,
  op: string,
  params: Record<string, unknown> = {},
  options: SendFirefoxBrokerRequestOptions = {},
): Promise<FirefoxBrokerResponse> {
  const id = options.id ?? crypto.randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_FIREFOX_BROKER_TIMEOUT_MS;
  const request: FirefoxBrokerRequest = {
    id,
    op,
    params,
    ...(options.audienceId ? { audience_id: options.audienceId } : {}),
  };

  if (options.signal?.aborted) {
    return {
      type: "response",
      id,
      ok: false,
      error: { code: "BROWSER_REQUEST_CANCELLED", message: "request aborted before broker dispatch" },
      outcome: "not_started",
    };
  }

  const attempt = async (): Promise<FirefoxBrokerResponse> => {
    const retry = options.readRetry;
    const attempts = Math.max(1, retry?.attempts ?? 1);
    let lastError: unknown;
    for (let index = 0; index < attempts; index += 1) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, (retry?.backoffMs ?? 0) * index));
        if (options.signal?.aborted) break;
      }
      try {
        return await exchange(session, request, timeoutMs);
      } catch (error) {
        lastError = error;
        if (!isFirefoxBrokerTransportError(error)) throw error;
      }
    }
    throw lastError;
  };
  const responsePromise = attempt();
  if (!options.signal) return responsePromise;

  const onAbort = () => {
    void exchange(
      session,
      {
        id: crypto.randomUUID(),
        op: "cancel_request",
        params: { target_request_id: id },
        ...(options.audienceId ? { audience_id: options.audienceId } : {}),
      },
      Math.min(timeoutMs, 5_000),
    ).catch(() => undefined);
  };

  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await responsePromise;
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}
