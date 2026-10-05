#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
const MAX_CLIENT_LINE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = Math.max(50, Number.parseInt(process.env.ZAMERY_BROWSER_FIREFOX_REQUEST_TIMEOUT_MS || "", 10) || 35_000);
const PROTOCOL_VERSION = 2;
const DURABLE_JOURNAL_VERSION = 2;
const MAX_DURABLE_MUTATIONS = 1024;
const REPLAY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const LATE_SETTLE_MS = 5 * 60 * 1000;
const MAX_LATE_ENTRIES = 256;
const MAX_PENDING_REQUESTS = 256;
const AUDIENCE_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
// Request ids minted by first-party consumers embed their creation time so the host can refuse
// ids that are older than the replay horizon instead of silently re-executing them.
const TIMESTAMPED_REQUEST_ID = /^zq1-([0-9a-z]{8,11})-[A-Za-z0-9_-]{8,}$/;
const DURABLE_OPS = new Set([
  "act",
  "create_tab",
  "close_owned_tab",
  "navigate_tab",
  "reload_tab",
  "activate_tab",
  "group_create",
  "group_update",
  "group_add_tabs",
  "group_remove_tabs",
  "group_move",
  "group_activate",
]);
const SAFE_RESULT_SCALAR_FIELDS = new Set([
  "outcome",
  "context_id",
  "ownership",
  "group_handle",
  "group_revision",
  "group_deleted",
  "focused_context_id",
]);
const SAFE_RESULT_LIST_FIELDS = new Set(["completed_substeps", "member_context_ids"]);

const uid = typeof process.getuid === "function" ? process.getuid() : "user";
const runtimeRoot = process.env.ZAMERY_BROWSER_FIREFOX_RUNTIME_DIR
  || path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `zamery-browser-firefox-${uid}`);
const sessionsDir = path.join(runtimeRoot, "sessions");
const durableStateDir = process.env.ZAMERY_BROWSER_FIREFOX_STATE_DIR
  || path.join(os.homedir(), "Library", "Application Support", "Zamery", "browser-firefox", "state");
const legacyMutationJournalPath = path.join(durableStateDir, "mutation-journal.json");
const sessionId = crypto.randomUUID();
const socketPath = path.join(runtimeRoot, `s-${crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.sock`);
const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
const startedAt = Date.now();

console.error(`[zamery-browser-firefox-host] startup pid=${process.pid} argv=${process.argv.length}`);
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(durableStateDir, { recursive: true, mode: 0o700 });
// The runtime root lives under a predictable /tmp path. Never publish a socket or session receipt into a
// directory another user could own or write to.
function requirePrivateDirectory(dir) {
  try { fs.chmodSync(dir, 0o700); } catch {}
  const stat = fs.lstatSync(dir);
  const ownerOk = typeof process.getuid !== "function" || stat.uid === process.getuid();
  if (stat.isSymbolicLink() || !stat.isDirectory() || !ownerOk || (stat.mode & 0o077) !== 0) {
    console.error(`[zamery-browser-firefox-host] refusing to start: ${dir} is not a private directory owned by this user`);
    process.exit(78);
  }
}
for (const dir of [runtimeRoot, sessionsDir, durableStateDir]) requirePrivateDirectory(dir);
try { fs.unlinkSync(socketPath); } catch {}

let session = {
  protocol_version: PROTOCOL_VERSION,
  journal_schema: DURABLE_JOURNAL_VERSION,
  companion_protocol_version: null,
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

// id -> { audience, volatile, waiters[], timer, request, startedAt }
const pending = new Map();
// Requests whose waiters already timed out but whose late companion response can still settle the journal.
const lateEntries = new Map();
const durableMutations = new Map();
const volatileMutationFingerprints = new Map();
const volatileFingerprintKey = crypto.randomBytes(32);
let inputBuffer = Buffer.alloc(0);
let mutationJournalPath = null;
let journalLockPath = null;
let journalLockHeld = false;
let evictedBefore = 0;
let loadedProfileKey = null;

function requestAudience(request) {
  const value = typeof request?.audience_id === "string" ? request.audience_id.trim() : "";
  return AUDIENCE_PATTERN.test(value) ? value : null;
}

function mutationKey(audience, id) {
  return `${audience}:${id}`;
}

function requestIdTimestamp(id) {
  const match = TIMESTAMPED_REQUEST_ID.exec(String(id || ""));
  if (!match) return null;
  const value = Number.parseInt(match[1], 36);
  return Number.isFinite(value) ? value : null;
}

function isSensitiveInputMutation(request) {
  if (request?.op !== "act") return false;
  const action = String(request?.params?.action || "");
  return action === "fill" || action === "type" || action === "key";
}

function safeString(value, limit = 256) {
  return typeof value === "string" && value.length <= limit ? value : null;
}

// Only opaque identifiers and enumerated action names are durable. Raw input, URLs and titles never are.
function durableMutationDescriptor(request, audience) {
  const params = request?.params && typeof request.params === "object" ? request.params : {};
  return {
    op: String(request?.op || ""),
    audience_id: audience,
    context_id: safeString(params.context_id),
    ref: safeString(params.ref, 1024),
    action: safeString(params.action, 32),
  };
}

function mutationFingerprint(request, audience) {
  return JSON.stringify(durableMutationDescriptor(request, audience));
}

function volatileMutationFingerprint(request, audience) {
  return crypto.createHmac("sha256", volatileFingerprintKey)
    .update(JSON.stringify({ op: request?.op, params: request?.params || {}, audience_id: audience }))
    .digest("hex");
}

function isDurableMutation(request) {
  return DURABLE_OPS.has(String(request?.op || ""));
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

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// One writer per journal partition. A second host process for the same profile must not interleave writes.
function ensureJournalLock() {
  if (journalLockHeld) return true;
  if (!journalLockPath) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(journalLockPath, "wx", 0o600);
      try { fs.writeFileSync(fd, `${process.pid}\n`); } finally { fs.closeSync(fd); }
      journalLockHeld = true;
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") return false;
      let ownerPid = 0;
      try { ownerPid = Number.parseInt(fs.readFileSync(journalLockPath, "utf8"), 10); } catch {}
      if (ownerPid === process.pid) {
        journalLockHeld = true;
        return true;
      }
      if (processAlive(ownerPid)) return false;
      try { fs.unlinkSync(journalLockPath); } catch { return false; }
    }
  }
  return false;
}

function releaseJournalLock() {
  if (!journalLockHeld || !journalLockPath) return;
  journalLockHeld = false;
  try { fs.unlinkSync(journalLockPath); } catch {}
}

function pruneJournal(now = Date.now()) {
  for (const [key, entry] of durableMutations) {
    const reference = entry.completed_at ?? entry.started_at ?? entry.migrated_at ?? now;
    if (now - reference > REPLAY_HORIZON_MS) durableMutations.delete(key);
  }
  while (durableMutations.size > MAX_DURABLE_MUTATIONS) {
    const oldestKey = durableMutations.keys().next().value;
    const oldest = durableMutations.get(oldestKey);
    evictedBefore = Math.max(evictedBefore, oldest?.started_at ?? oldest?.migrated_at ?? 0);
    durableMutations.delete(oldestKey);
  }
}

function persistDurableMutations() {
  if (!mutationJournalPath) throw new Error("mutation journal is not attached to a browser profile");
  if (!ensureJournalLock()) throw new Error("mutation journal is owned by another host process");
  pruneJournal();
  const entries = Array.from(durableMutations.values());
  const tmp = `${mutationJournalPath}.${process.pid}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ version: DURABLE_JOURNAL_VERSION, evicted_before: evictedBefore, entries }, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.renameSync(tmp, mutationJournalPath);
  try { fs.chmodSync(mutationJournalPath, 0o600); } catch {}
  fsyncDir(durableStateDir);
}

function profileJournalPath(profileId) {
  const profileKey = crypto.createHash("sha256").update(String(profileId || "unknown-profile")).digest("hex").slice(0, 24);
  return path.join(durableStateDir, `mutation-journal-v2-${profileKey}.json`);
}

function safeLegacyTombstone(entry) {
  if (!entry || typeof entry.id !== "string") return null;
  return {
    id: entry.id,
    audience_id: "legacy-unknown-audience",
    safe_fingerprint: null,
    sensitive_input: true,
    state: "legacy_tombstone",
    migrated_at: Date.now(),
  };
}

function cleanupLegacyJournalFiles() {
  for (const name of fs.readdirSync(durableStateDir)) {
    if (name === path.basename(legacyMutationJournalPath) || name.startsWith(`${path.basename(legacyMutationJournalPath)}.`)) {
      try { fs.unlinkSync(path.join(durableStateDir, name)); } catch {}
    }
  }
}

function sanitizeLoadedEntry(entry) {
  if (!entry || typeof entry.id !== "string" || entry.id.length > 256) return null;
  const audienceId = typeof entry.audience_id === "string" ? entry.audience_id : "legacy-unknown-audience";
  const state = ["started", "completed", "legacy_tombstone"].includes(entry.state) ? entry.state : "legacy_tombstone";
  return {
    id: entry.id,
    audience_id: audienceId,
    op: typeof entry.op === "string" ? entry.op : "act",
    safe_fingerprint: typeof entry.safe_fingerprint === "string" ? entry.safe_fingerprint : null,
    sensitive_input: entry.sensitive_input === true,
    state,
    ...(Number.isFinite(entry.started_at) ? { started_at: entry.started_at } : {}),
    ...(Number.isFinite(entry.completed_at) ? { completed_at: entry.completed_at } : {}),
    ...(Number.isFinite(entry.migrated_at) ? { migrated_at: entry.migrated_at } : {}),
    ...(entry.response && typeof entry.response === "object" ? { response: sanitizeStoredResponse(entry.response) } : {}),
  };
}

function loadDurableMutations(profileId) {
  const nextPath = profileJournalPath(profileId);
  if (loadedProfileKey === nextPath) return;
  releaseJournalLock();
  durableMutations.clear();
  volatileMutationFingerprints.clear();
  evictedBefore = 0;
  mutationJournalPath = nextPath;
  journalLockPath = `${nextPath}.lock`;
  loadedProfileKey = nextPath;

  if (fs.existsSync(mutationJournalPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mutationJournalPath, "utf8"));
      if (parsed?.version !== DURABLE_JOURNAL_VERSION || !Array.isArray(parsed?.entries)) throw new Error("unsupported journal schema");
      if (Number.isFinite(parsed.evicted_before)) evictedBefore = parsed.evicted_before;
      for (const entry of parsed.entries.slice(-MAX_DURABLE_MUTATIONS)) {
        const safeEntry = sanitizeLoadedEntry(entry);
        if (safeEntry) durableMutations.set(mutationKey(safeEntry.audience_id, safeEntry.id), safeEntry);
      }
    } catch (error) {
      console.error(`[zamery-browser-firefox-host] durable journal load failed: ${error?.message || error}`);
      // Never keep trusting a journal we cannot parse: preserve it for forensics and refuse older ids.
      try { fs.renameSync(mutationJournalPath, `${mutationJournalPath}.corrupt-${Date.now()}`); } catch {}
      durableMutations.clear();
      evictedBefore = Date.now();
    }
  }

  if (fs.existsSync(legacyMutationJournalPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyMutationJournalPath, "utf8"));
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      for (const entry of entries.slice(-MAX_DURABLE_MUTATIONS)) {
        const tombstone = safeLegacyTombstone(entry);
        if (tombstone) durableMutations.set(mutationKey(tombstone.audience_id, tombstone.id), tombstone);
      }
      try {
        persistDurableMutations();
      } catch (error) {
        console.error(`[zamery-browser-firefox-host] legacy tombstone persist failed: ${error?.message || error}`);
      }
    } catch (error) {
      console.error(`[zamery-browser-firefox-host] legacy journal migration failed: ${error?.message || error}`);
    } finally {
      // The privacy goal (no plaintext payloads on disk) outranks tombstone completeness.
      cleanupLegacyJournalFiles();
    }
  }
}

function replyFor(request, fields) {
  return { type: "response", id: request.id, replayed: true, ...fields };
}

function conflictReply(request) {
  return replyFor(request, {
    ok: false,
    error: { code: "REQUEST_ID_CONFLICT", message: "mutation request id was reused with different parameters" },
    outcome: "not_started",
  });
}

function unknownReply(request, message) {
  return replyFor(request, {
    ok: false,
    error: { code: "MUTATION_OUTCOME_UNKNOWN", message },
    outcome: "outcome_unknown",
  });
}

function horizonReply(request) {
  return replyFor(request, {
    ok: false,
    error: { code: "REPLAY_HORIZON_EXPIRED", message: "request id is outside the durable replay horizon" },
    outcome: "not_started",
  });
}

function outsideReplayHorizon(request, now = Date.now()) {
  const stamped = requestIdTimestamp(request.id);
  if (stamped === null) return false;
  return now - stamped > REPLAY_HORIZON_MS || stamped <= evictedBefore;
}

function durableMutationLookup(request, audience) {
  if (!isDurableMutation(request)) return null;
  const key = mutationKey(audience, request.id);
  const existing = durableMutations.get(key);
  if (!existing) return outsideReplayHorizon(request) ? horizonReply(request) : null;
  if (existing.safe_fingerprint && existing.safe_fingerprint !== mutationFingerprint(request, audience)) return conflictReply(request);
  const volatile = volatileMutationFingerprints.get(key);
  if (volatile && volatile !== volatileMutationFingerprint(request, audience)) return conflictReply(request);
  if (existing.state === "legacy_tombstone" || (existing.sensitive_input && !volatile)) {
    return unknownReply(request, "prior sensitive mutation cannot be safely reconciled after restart");
  }
  if (existing.state === "completed" && existing.response) {
    return { ...existing.response, id: request.id, replayed: true };
  }
  return unknownReply(request, "a prior mutation with this request id started but has no durable completion record");
}

function durableMutationStart(request, audience) {
  const key = mutationKey(audience, request.id);
  volatileMutationFingerprints.set(key, volatileMutationFingerprint(request, audience));
  durableMutations.set(key, {
    id: request.id,
    audience_id: audience,
    op: String(request.op),
    safe_fingerprint: mutationFingerprint(request, audience),
    sensitive_input: isSensitiveInputMutation(request),
    state: "started",
    started_at: Date.now(),
  });
  try {
    persistDurableMutations();
  } catch (error) {
    durableMutations.delete(key);
    volatileMutationFingerprints.delete(key);
    throw error;
  }
}

function sanitizeStoredResponse(response) {
  const error = response?.error && typeof response.error === "object"
    ? {
        code: typeof response.error.code === "string" ? response.error.code.slice(0, 64) : "BROWSER_PROVIDER_ERROR",
        ...(typeof response.error.reason === "string" ? { reason: response.error.reason.slice(0, 64) } : {}),
      }
    : undefined;
  const result = {};
  const source = response?.result && typeof response.result === "object" ? response.result : {};
  for (const field of SAFE_RESULT_SCALAR_FIELDS) {
    const value = source[field];
    if (typeof value === "string" && value.length <= 256) result[field] = value;
    else if (typeof value === "number" && Number.isFinite(value)) result[field] = value;
    else if (typeof value === "boolean") result[field] = value;
  }
  for (const field of SAFE_RESULT_LIST_FIELDS) {
    const value = source[field];
    if (Array.isArray(value) && value.length <= 16 && value.every((item) => typeof item === "string" && item.length <= 256)) {
      result[field] = value;
    }
  }
  return {
    type: "response",
    ...(typeof response?.id === "string" ? { id: response.id } : {}),
    ok: response?.ok === true,
    ...(["not_started", "completed", "partially_applied", "outcome_unknown"].includes(response?.outcome) ? { outcome: response.outcome } : {}),
    ...(error ? { error } : {}),
    ...(response?.ok === true ? { result: { outcome: "completed", ...result } } : {}),
  };
}

function forgetDurableMutation(request, audience) {
  const key = mutationKey(audience, request.id);
  durableMutations.delete(key);
  volatileMutationFingerprints.delete(key);
  persistDurableMutations();
}

function durableMutationComplete(request, audience, response) {
  const key = mutationKey(audience, request.id);
  if (!volatileMutationFingerprints.has(key)) volatileMutationFingerprints.set(key, volatileMutationFingerprint(request, audience));
  const previous = durableMutations.get(key);
  durableMutations.set(key, {
    id: request.id,
    audience_id: audience,
    op: String(request.op),
    safe_fingerprint: mutationFingerprint(request, audience),
    sensitive_input: isSensitiveInputMutation(request),
    state: "completed",
    started_at: previous?.started_at ?? Date.now(),
    completed_at: Date.now(),
    response: sanitizeStoredResponse(response),
  });
  persistDurableMutations();
}

function mutationStatus(request, audience) {
  const targetId = safeString(request?.params?.request_id, 256);
  if (!targetId) {
    return { type: "response", id: request.id, ok: false, error: { code: "INVALID_REQUEST", message: "mutation_status requires params.request_id" }, outcome: "not_started" };
  }
  const key = mutationKey(audience, targetId);
  const inflight = pending.get(targetId);
  const entry = durableMutations.get(key);
  let state;
  let outcome;
  if (inflight && inflight.audience === audience) {
    state = "in_flight";
  } else if (entry?.state === "completed") {
    state = "completed";
    outcome = entry.response?.outcome ?? (entry.response?.ok === true ? "completed" : "not_started");
  } else if (entry?.state === "started" || entry?.state === "legacy_tombstone" || lateEntries.has(targetId)) {
    state = "outcome_unknown";
    outcome = "outcome_unknown";
  } else if (outsideReplayHorizon({ id: targetId })) {
    state = "outside_replay_horizon";
  } else {
    state = "not_found";
  }
  return {
    type: "response",
    id: request.id,
    ok: true,
    result: {
      request_id: targetId,
      state,
      ...(outcome ? { outcome } : {}),
      ...(entry?.op ? { op: entry.op } : {}),
      ...(Number.isFinite(entry?.started_at) ? { started_at: entry.started_at } : {}),
      ...(Number.isFinite(entry?.completed_at) ? { completed_at: entry.completed_at } : {}),
      replay_horizon_ms: REPLAY_HORIZON_MS,
    },
  };
}

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

function settlePending(id, value) {
  const entry = pending.get(id);
  if (entry) {
    pending.delete(id);
    clearTimeout(entry.timer);
    let delivered = value;
    if (isDurableMutation(entry.request) && value?.ok !== true && value?.outcome === "not_started") {
      // Nothing happened, so there is nothing to reconcile: forget the attempt and let a retry with the same
      // id run for real (the tool contract says to reuse the id to retry).
      try { forgetDurableMutation(entry.request, entry.audience); } catch (error) { console.error(`[zamery-browser-firefox-host] forget failed: ${error?.message || error}`); }
    } else if (isDurableMutation(entry.request)) {
      try {
        durableMutationComplete(entry.request, entry.audience, value);
      } catch (error) {
        delivered = {
          type: "response",
          id,
          ok: false,
          error: { code: "MUTATION_JOURNAL_PERSIST_FAILED", message: String(error?.message || error).slice(0, 200) },
          outcome: "outcome_unknown",
        };
      }
    }
    for (const waiter of entry.waiters) waiter({ ...delivered, id });
    return;
  }
  const late = lateEntries.get(id);
  if (late) {
    lateEntries.delete(id);
    try {
      if (isDurableMutation(late.request)) {
        if (value?.ok !== true && value?.outcome === "not_started") forgetDurableMutation(late.request, late.audience);
        else durableMutationComplete(late.request, late.audience, value);
      }
    } catch (error) {
      console.error(`[zamery-browser-firefox-host] late settle failed: ${error?.message || error}`);
    }
  }
}

function handleNative(value) {
  if (!value || typeof value !== "object") return;
  // Heartbeats arrive every few seconds; logging them grew the stderr log without bound.
  if (value.type !== "heartbeat") console.error(`[zamery-browser-firefox-host] native message type=${String(value.type || "unknown")}`);
  if (value.type === "hello") {
    session = {
      ...session,
      companion_protocol_version: Number.isInteger(value.protocol_version) ? value.protocol_version : null,
      profile_id: value.profile_id || null,
      browser_instance_id: value.browser_instance_id || null,
      extension_id: value.extension_id || null,
      extension_version: value.extension_version || null,
      last_heartbeat_at: Date.now(),
    };
    loadDurableMutations(session.profile_id);
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
  if (value.type === "response" && typeof value.id === "string") settlePending(value.id, value);
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

function cancelRequest(request, audience) {
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
  const target = pending.get(targetId);
  if (!target || target.audience !== audience) {
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

function failure(id, code, message, outcome = "not_started") {
  return { type: "response", id, ok: false, error: { code, message }, outcome };
}

function forwardRequest(request) {
  if (!request || typeof request !== "object" || typeof request.id !== "string" || request.id.length === 0 || request.id.length > 256) {
    return Promise.resolve(failure(typeof request?.id === "string" ? request.id.slice(0, 256) : "invalid", "INVALID_REQUEST", "request requires string id"));
  }
  const audience = requestAudience(request);
  if (!audience) {
    return Promise.resolve(failure(request.id, "AUDIENCE_REQUIRED", "request requires a valid audience_id (protocol 2)"));
  }
  if (!session.browser_instance_id) {
    return Promise.resolve(failure(request.id, "COMPANION_NOT_READY", "extension hello not received"));
  }
  if (session.companion_protocol_version !== PROTOCOL_VERSION && request.op !== "status") {
    return Promise.resolve(failure(
      request.id,
      "BROWSER_PROTOCOL_MISMATCH",
      `native host protocol ${PROTOCOL_VERSION} does not match companion protocol ${session.companion_protocol_version}`,
    ));
  }

  if (request.op === "cancel_request") return Promise.resolve(cancelRequest(request, audience));
  if (request.op === "mutation_status") return Promise.resolve(mutationStatus(request, audience));

  const volatile = volatileMutationFingerprint(request, audience);
  const inflight = pending.get(request.id);
  if (inflight) {
    if (inflight.audience !== audience || inflight.volatile !== volatile) {
      return Promise.resolve(conflictReply(request));
    }
    return new Promise((resolve) => inflight.waiters.push((value) => resolve({ ...value, replayed: true })));
  }
  if (pending.size >= MAX_PENDING_REQUESTS) {
    return Promise.resolve(failure(request.id, "BROKER_BUSY", "too many in-flight broker requests"));
  }

  const durable = isDurableMutation(request);
  if (durable) {
    const replay = durableMutationLookup(request, audience);
    if (replay) return Promise.resolve(replay);
    try {
      durableMutationStart(request, audience);
    } catch (error) {
      return Promise.resolve(failure(request.id, "MUTATION_JOURNAL_UNAVAILABLE", String(error?.message || error).slice(0, 200)));
    }
  }

  return new Promise((resolve) => {
    const entry = {
      audience,
      volatile,
      request: { id: request.id, op: request.op, params: request.params || {}, audience_id: audience },
      waiters: [resolve],
      startedAt: Date.now(),
      timer: null,
    };
    entry.timer = setTimeout(() => {
      if (pending.get(request.id) !== entry) return;
      pending.delete(request.id);
      if (durable) {
        lateEntries.set(request.id, entry);
        while (lateEntries.size > MAX_LATE_ENTRIES) lateEntries.delete(lateEntries.keys().next().value);
        setTimeout(() => { if (lateEntries.get(request.id) === entry) lateEntries.delete(request.id); }, LATE_SETTLE_MS).unref?.();
      }
      const timeout = failure(request.id, "BROKER_RESPONSE_TIMEOUT", "extension response not observed before deadline", "outcome_unknown");
      for (const waiter of entry.waiters) waiter(timeout);
    }, REQUEST_TIMEOUT_MS);
    pending.set(request.id, entry);
    try {
      writeNative({
        type: "request",
        id: request.id,
        op: request.op,
        params: request.params || {},
        audience_id: audience,
      });
    } catch (error) {
      clearTimeout(entry.timer);
      pending.delete(request.id);
      const written = failure(request.id, "NATIVE_WRITE_FAILED", String(error?.message || error).slice(0, 200), durable ? "outcome_unknown" : "not_started");
      for (const waiter of entry.waiters) waiter(written);
    }
  });
}

function handleClient(socket) {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("error", () => {});
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
      if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
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
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    const exited = failure(id, "BROKER_EXITED", "native host exited", "outcome_unknown");
    for (const waiter of entry.waiters) waiter(exited);
  }
  pending.clear();
  releaseJournalLock();
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
