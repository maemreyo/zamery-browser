#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
const MAX_CLIENT_LINE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 35_000;
const PROTOCOL_VERSION = 1;
const MAX_DURABLE_MUTATIONS = 256;

const uid = typeof process.getuid === "function" ? process.getuid() : "user";
const runtimeRoot = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `zamery-browser-firefox-${uid}`);
const sessionsDir = path.join(runtimeRoot, "sessions");
const durableStateDir = path.join(os.homedir(), "Library", "Application Support", "Zamery", "browser-firefox", "state");
const mutationJournalPath = path.join(durableStateDir, "mutation-journal.json");
const sessionId = crypto.randomUUID();
const socketPath = path.join(runtimeRoot, `s-${crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.sock`);
const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
const startedAt = Date.now();

console.error(`[zamery-browser-firefox-host] startup pid=${process.pid} argv=${process.argv.length}`);
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(durableStateDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(runtimeRoot, 0o700); } catch {}
try { fs.chmodSync(sessionsDir, 0o700); } catch {}
try { fs.chmodSync(durableStateDir, 0o700); } catch {}
try { fs.unlinkSync(socketPath); } catch {}

let session = {
  protocol_version: PROTOCOL_VERSION,
  session_id: sessionId,
  socket_path: socketPath,
  host_pid: process.pid,
  started_at: startedAt,
  last_heartbeat_at: startedAt,
  profile_id: null,
  browser_instance_id: null,
  extension_id: null,
  extension_version: null,
};

const pending = new Map();
const durableMutations = new Map();
let inputBuffer = Buffer.alloc(0);

function mutationFingerprint(request) {
  return JSON.stringify({ op: request.op, params: request.params || {} });
}

function isDurableMutation(request) {
  return request?.op === "act";
}

function fsyncDir(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function persistDurableMutations() {
  const entries = Array.from(durableMutations.values()).slice(-MAX_DURABLE_MUTATIONS);
  const tmp = `${mutationJournalPath}.${process.pid}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.renameSync(tmp, mutationJournalPath);
  try { fs.chmodSync(mutationJournalPath, 0o600); } catch {}
  fsyncDir(durableStateDir);
}

function loadDurableMutations() {
  if (!fs.existsSync(mutationJournalPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(mutationJournalPath, "utf8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const entry of entries.slice(-MAX_DURABLE_MUTATIONS)) {
      if (entry && typeof entry.id === "string") durableMutations.set(entry.id, entry);
    }
  } catch (error) {
    console.error(`[zamery-browser-firefox-host] durable journal load failed: ${error?.stack || error}`);
  }
}

function durableMutationLookup(request) {
  if (!isDurableMutation(request)) return null;
  const existing = durableMutations.get(request.id);
  if (!existing) return null;
  const fingerprint = mutationFingerprint(request);
  if (existing.fingerprint !== fingerprint) {
    return {
      type: "response",
      id: request.id,
      replayed: true,
      ok: false,
      error: { code: "REQUEST_ID_CONFLICT", message: "mutation request id was reused with different parameters" },
      outcome: "not_started",
    };
  }
  if (existing.state === "completed" && existing.response) {
    return { ...existing.response, id: request.id, replayed: true };
  }
  return {
    type: "response",
    id: request.id,
    replayed: true,
    ok: false,
    error: { code: "MUTATION_OUTCOME_UNKNOWN", message: "a prior mutation with this request id started but has no durable completion record" },
    outcome: "outcome_unknown",
  };
}

function durableMutationStart(request) {
  if (!isDurableMutation(request)) return;
  durableMutations.set(request.id, {
    id: request.id,
    fingerprint: mutationFingerprint(request),
    state: "started",
    started_at: Date.now(),
  });
  while (durableMutations.size > MAX_DURABLE_MUTATIONS) durableMutations.delete(durableMutations.keys().next().value);
  persistDurableMutations();
}

function durableMutationComplete(request, response) {
  if (!isDurableMutation(request)) return;
  durableMutations.set(request.id, {
    id: request.id,
    fingerprint: mutationFingerprint(request),
    state: "completed",
    completed_at: Date.now(),
    response: JSON.parse(JSON.stringify(response)),
  });
  while (durableMutations.size > MAX_DURABLE_MUTATIONS) durableMutations.delete(durableMutations.keys().next().value);
  persistDurableMutations();
}

loadDurableMutations();

function writeSession() {
  const tmp = `${sessionPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, sessionPath);
  try { fs.chmodSync(sessionPath, 0o600); } catch {}
}

function writeNative(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length <= 0 || body.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error(`native outbound frame exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

function handleNative(value) {
  if (!value || typeof value !== "object") return;
  console.error(`[zamery-browser-firefox-host] native message type=${String(value.type || "unknown")}`);
  if (value.type === "hello") {
    session = {
      ...session,
      protocol_version: value.protocol_version,
      profile_id: value.profile_id || null,
      browser_instance_id: value.browser_instance_id || null,
      extension_id: value.extension_id || null,
      extension_version: value.extension_version || null,
      last_heartbeat_at: Date.now(),
    };
    writeSession();
    return;
  }
  if (value.type === "heartbeat") {
    session = {
      ...session,
      profile_id: value.profile_id || session.profile_id,
      browser_instance_id: value.browser_instance_id || session.browser_instance_id,
      active_context_id: value.active_context_id ?? null,
      last_heartbeat_at: Date.now(),
    };
    writeSession();
    return;
  }
  if (value.type === "response" && typeof value.id === "string") {
    const waiter = pending.get(value.id);
    if (waiter) {
      pending.delete(value.id);
      clearTimeout(waiter.timer);
      try {
        durableMutationComplete(waiter.request, value);
        waiter.resolve(value);
      } catch (error) {
        waiter.resolve({
          type: "response",
          id: value.id,
          ok: false,
          error: { code: "MUTATION_JOURNAL_PERSIST_FAILED", message: String(error?.message || error) },
          outcome: "outcome_unknown",
        });
      }
    }
  }
}

function parseNativeInput(chunk) {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.length >= 4) {
    const length = inputBuffer.readUInt32LE(0);
    if (length <= 0 || length > MAX_NATIVE_MESSAGE_BYTES) {
      throw new Error(`native inbound frame invalid: ${length}`);
    }
    if (inputBuffer.length < 4 + length) return;
    const body = inputBuffer.subarray(4, 4 + length);
    inputBuffer = inputBuffer.subarray(4 + length);
    handleNative(JSON.parse(body.toString("utf8")));
  }
}

process.stdin.on("data", (chunk) => {
  console.error(`[zamery-browser-firefox-host] stdin data bytes=${chunk.length}`);
  try {
    parseNativeInput(chunk);
  } catch (error) {
    console.error(`[zamery-browser-firefox-host] ${error?.stack || error}`);
    process.exitCode = 1;
    process.stdin.pause();
  }
});
process.stdin.on("end", () => {
  console.error("[zamery-browser-firefox-host] stdin end");
  cleanupAndExit(0);
});
process.stdin.resume();

function cancelRequest(request) {
  const targetId = String(request?.params?.target_request_id || "");
  if (!targetId) {
    return {
      type: "response",
      id: request.id,
      ok: false,
      error: { code: "INVALID_CANCEL_REQUEST", message: "cancel_request requires target_request_id" },
      outcome: "not_started",
    };
  }
  if (!pending.has(targetId)) {
    return {
      type: "response",
      id: request.id,
      ok: true,
      result: { target_request_id: targetId, dispatched: false, reason: "not_in_flight" },
    };
  }
  try {
    writeNative({ type: "cancel", id: request.id, target_id: targetId });
    return {
      type: "response",
      id: request.id,
      ok: true,
      result: { target_request_id: targetId, dispatched: true },
    };
  } catch (error) {
    return {
      type: "response",
      id: request.id,
      ok: false,
      error: { code: "CANCEL_DISPATCH_FAILED", message: String(error?.message || error) },
      outcome: "not_started",
    };
  }
}

function forwardRequest(request) {
  if (!request || typeof request !== "object" || typeof request.id !== "string") {
    return Promise.resolve({
      type: "response",
      id: request?.id || "invalid",
      ok: false,
      error: { code: "INVALID_REQUEST", message: "request requires string id" },
      outcome: "not_started",
    });
  }
  if (!session.browser_instance_id) {
    return Promise.resolve({
      type: "response",
      id: request.id,
      ok: false,
      error: { code: "COMPANION_NOT_READY", message: "extension hello not received" },
      outcome: "not_started",
    });
  }

  if (request.op === "cancel_request") return Promise.resolve(cancelRequest(request));

  const durableReplay = durableMutationLookup(request);
  if (durableReplay) return Promise.resolve(durableReplay);

  if (isDurableMutation(request)) {
    try {
      durableMutationStart(request);
    } catch (error) {
      return Promise.resolve({
        type: "response",
        id: request.id,
        ok: false,
        error: { code: "MUTATION_JOURNAL_UNAVAILABLE", message: String(error?.message || error) },
        outcome: "not_started",
      });
    }
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request.id);
      resolve({
        type: "response",
        id: request.id,
        ok: false,
        error: { code: "BROKER_RESPONSE_TIMEOUT", message: "extension response not observed before deadline" },
        outcome: "outcome_unknown",
      });
    }, REQUEST_TIMEOUT_MS);
    pending.set(request.id, { resolve, timer, request });
    try {
      writeNative({
        type: "request",
        id: request.id,
        op: request.op,
        params: request.params || {},
      });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(request.id);
      resolve({
        type: "response",
        id: request.id,
        ok: false,
        error: { code: "NATIVE_WRITE_FAILED", message: String(error?.message || error) },
        outcome: isDurableMutation(request) ? "outcome_unknown" : "not_started",
      });
    }
  });
}

function handleClient(socket) {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", async (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_CLIENT_LINE_BYTES) {
      socket.end(`${JSON.stringify({ ok: false, error: { code: "CLIENT_FRAME_TOO_LARGE" } })}\n`);
      return;
    }
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        socket.write(`${JSON.stringify({ ok: false, error: { code: "INVALID_JSON" } })}\n`);
        continue;
      }
      const response = await forwardRequest(request);
      socket.write(`${JSON.stringify(response)}\n`);
    }
  });
}

const server = net.createServer(handleClient);
server.listen(socketPath, () => {
  console.error(`[zamery-browser-firefox-host] uds listening ${socketPath}`);
  try { fs.chmodSync(socketPath, 0o600); } catch {}
  writeSession();
  writeNative({
    type: "host_status",
    protocol_version: PROTOCOL_VERSION,
    host_session_id: sessionId,
    host_pid: process.pid,
    started_at: startedAt,
  });
});
server.on("error", (error) => {
  console.error(`[zamery-browser-firefox-host] socket error: ${error?.stack || error}`);
  cleanupAndExit(1);
});

let exiting = false;
function cleanupAndExit(code) {
  if (exiting) return;
  exiting = true;
  console.error(`[zamery-browser-firefox-host] cleanup code=${code}`);
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.resolve({
      type: "response",
      id: "unknown",
      ok: false,
      error: { code: "BROKER_EXITED", message: "native host exited" },
      outcome: "outcome_unknown",
    });
  }
  pending.clear();
  try { server.close(); } catch {}
  try { fs.unlinkSync(socketPath); } catch {}
  try { fs.unlinkSync(sessionPath); } catch {}
  process.exit(code);
}

process.on("SIGTERM", () => cleanupAndExit(0));
process.on("SIGINT", () => cleanupAndExit(0));
process.on("uncaughtException", (error) => {
  console.error(`[zamery-browser-firefox-host] uncaught: ${error?.stack || error}`);
  cleanupAndExit(1);
});
