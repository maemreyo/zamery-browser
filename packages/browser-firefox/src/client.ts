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
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Firefox broker response timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => clearTimeout(timer);
    const rejectPrematureClose = (event: "ended" | "closed") => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Firefox broker connection ${event} before a complete response frame`));
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FIREFOX_BROKER_RESPONSE_LINE_BYTES) {
        settled = true;
        cleanup();
        socket.destroy();
        reject(new Error(`Firefox broker response exceeds ${MAX_FIREFOX_BROKER_RESPONSE_LINE_BYTES} bytes`));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      settled = true;
      cleanup();
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as FirefoxBrokerResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("end", () => rejectPrematureClose("ended"));
    socket.on("close", () => rejectPrematureClose("closed"));
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
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
  const request: FirefoxBrokerRequest = { id, op, params };

  if (options.signal?.aborted) {
    return {
      type: "response",
      id,
      ok: false,
      error: { code: "BROWSER_REQUEST_CANCELLED", message: "request aborted before broker dispatch" },
      outcome: "not_started",
    };
  }

  const responsePromise = exchange(session, request, timeoutMs);
  if (!options.signal) return responsePromise;

  const onAbort = () => {
    void exchange(
      session,
      {
        id: crypto.randomUUID(),
        op: "cancel_request",
        params: { target_request_id: id },
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
