import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  FakeFirefox,
  brokerCall,
  makeTempRoot,
  readAllFiles,
  stampedRequestId,
} from "./helpers/native-host-harness.mjs";

const AUD_A = "audience-aaaaaaaa";
const AUD_B = "audience-bbbbbbbb";
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function boot(options = {}) {
  const roots = options.roots ?? makeTempRoot();
  const firefox = new FakeFirefox({ roots, ...options });
  if (options.requestTimeoutMs) process.env.ZAMERY_BROWSER_FIREFOX_REQUEST_TIMEOUT_MS = String(options.requestTimeoutMs);
  await firefox.start();
  delete process.env.ZAMERY_BROWSER_FIREFOX_REQUEST_TIMEOUT_MS;
  cleanups.push(async () => { await firefox.kill(); if (!options.keepRoots) roots.cleanup(); });
  return { roots, firefox, session: firefox.session() };
}

const act = (id, audience, params, extra = {}) => ({
  id, op: "act", audience_id: audience, params: { context_id: "tab:1", ref: "r1.abc", ...params }, ...extra,
});

const okHandler = async (message) => ({
  ok: true,
  outcome: "completed",
  // Deliberately page-bearing: none of this may reach durable storage.
  result: { outcome: "completed", page_text: "PAGE-CANARY-9d1", ok: true, mechanism: "dom-synthetic" },
});

describe("native host journal privacy (F01)", () => {
  it("never persists fill/type/key payloads or page-bearing results", async () => {
    const { roots, firefox, session } = await boot({ handler: okHandler });
    const canaries = ["FILL-CANARY-7f3a", "TYPE-CANARY-2b9c", "KEY-CANARY-c41d"];
    for (const [action, field, value] of [["fill", "value", canaries[0]], ["type", "text", canaries[1]], ["key", "key", canaries[2]]]) {
      const response = await brokerCall(session, act(stampedRequestId(), AUD_A, { action, [field]: value }));
      assert.equal(response.ok, true);
    }
    const files = [...readAllFiles(roots.stateDir), ...readAllFiles(roots.runtimeDir)];
    assert.ok(files.length > 0);
    for (const file of files) {
      for (const canary of [...canaries, "PAGE-CANARY-9d1"]) {
        assert.ok(!file.text.includes(canary), `${canary} leaked into ${file.path}`);
      }
    }
    for (const canary of [...canaries, "PAGE-CANARY-9d1"]) assert.ok(!firefox.stderr.includes(canary), `${canary} leaked to stderr`);
  });

  it("returns outcome_unknown for a sensitive mutation replayed after host restart without dispatching it", async () => {
    const roots = makeTempRoot();
    const id = stampedRequestId();
    const first = await boot({ roots, keepRoots: true, handler: okHandler });
    const done = await brokerCall(first.session, act(id, AUD_A, { action: "fill", value: "SECRET-VALUE-1" }));
    assert.equal(done.ok, true);
    await first.firefox.stop();

    const second = await boot({ roots, handler: okHandler });
    const replay = await brokerCall(second.session, act(id, AUD_A, { action: "fill", value: "SECRET-VALUE-1" }));
    assert.equal(replay.ok, false);
    assert.equal(replay.outcome, "outcome_unknown");
    assert.equal(replay.error.code, "MUTATION_OUTCOME_UNKNOWN");
    assert.equal(second.firefox.requestsOfType("act").length, 0, "restart replay must not re-dispatch");
  });

  it("replays a completed non-sensitive mutation from a safe record without re-dispatch", async () => {
    const { firefox, session } = await boot({ handler: okHandler });
    const id = stampedRequestId();
    const first = await brokerCall(session, act(id, AUD_A, { action: "click" }));
    const second = await brokerCall(session, act(id, AUD_A, { action: "click" }));
    assert.equal(first.ok, true);
    assert.equal(second.replayed, true);
    assert.equal(second.outcome, "completed");
    assert.equal(firefox.requestsOfType("act").length, 1);
    assert.equal(second.result.page_text, undefined);
  });

  it("detects same-process reuse of a request id with different sensitive text", async () => {
    const { firefox, session } = await boot({ handler: okHandler });
    const id = stampedRequestId();
    await brokerCall(session, act(id, AUD_A, { action: "fill", value: "one" }));
    const conflict = await brokerCall(session, act(id, AUD_A, { action: "fill", value: "two" }));
    assert.equal(conflict.error.code, "REQUEST_ID_CONFLICT");
    assert.equal(conflict.outcome, "not_started");
    assert.equal(firefox.requestsOfType("act").length, 1);
  });

  it("migrates a legacy plaintext journal to safe tombstones and deletes the legacy files", async () => {
    const roots = makeTempRoot();
    fs.mkdirSync(roots.stateDir, { recursive: true });
    const legacy = path.join(roots.stateDir, "mutation-journal.json");
    fs.writeFileSync(legacy, JSON.stringify({ version: 1, entries: [{ id: "legacy-req-1", state: "completed", fingerprint: JSON.stringify({ params: { value: "LEGACY-PLAINTEXT-CANARY" } }) }] }));
    fs.writeFileSync(`${legacy}.123.tmp`, "LEGACY-PLAINTEXT-CANARY");
    const { firefox, session } = await boot({ roots, handler: okHandler });
    await firefox.waitForSession();
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.existsSync(`${legacy}.123.tmp`), false);
    for (const file of readAllFiles(roots.stateDir)) assert.ok(!file.text.includes("LEGACY-PLAINTEXT-CANARY"));
    const replay = await brokerCall(session, act("legacy-req-1", "legacy-unknown-audience", { action: "click" }));
    assert.equal(replay.outcome, "outcome_unknown");
    assert.equal(firefox.requestsOfType("act").length, 0);
  });
});

describe("audience, profile and replay isolation (F05)", () => {
  it("rejects requests without a valid audience", async () => {
    const { session } = await boot({ handler: okHandler });
    const response = await brokerCall(session, { id: "no-audience-1", op: "list_contexts", params: {} });
    assert.equal(response.error.code, "AUDIENCE_REQUIRED");
    assert.equal(response.outcome, "not_started");
  });

  it("does not replay one audience's completed mutation to another", async () => {
    const { firefox, session } = await boot({ handler: okHandler });
    const id = stampedRequestId();
    await brokerCall(session, act(id, AUD_A, { action: "click" }));
    const other = await brokerCall(session, act(id, AUD_B, { action: "click" }));
    assert.equal(other.replayed, undefined);
    assert.equal(firefox.requestsOfType("act").length, 2);
  });

  it("partitions the journal by Firefox profile", async () => {
    const roots = makeTempRoot();
    const rootsB = { ...roots, runtimeDir: path.join(roots.root, "r2") };
    const a = await boot({ roots, keepRoots: true, profileId: "profile-a", handler: okHandler });
    const b = await boot({ roots: rootsB, profileId: "profile-b", handler: okHandler });
    const id = stampedRequestId();
    await brokerCall(a.session, act(id, AUD_A, { action: "click" }));
    const crossProfile = await brokerCall(b.session, act(id, AUD_A, { action: "click" }));
    assert.equal(crossProfile.replayed, undefined, "profile B must not see profile A's journal");
    const journals = fs.readdirSync(roots.stateDir).filter((name) => /^mutation-journal-v2-.*\.json$/.test(name));
    assert.equal(journals.length, 2);
  });

  it("refuses mutations when another live host owns the journal (single writer)", async () => {
    const roots = makeTempRoot();
    const rootsB = { ...roots, runtimeDir: path.join(roots.root, "r2") };
    const a = await boot({ roots, keepRoots: true, profileId: "profile-same", handler: okHandler });
    const b = await boot({ roots: rootsB, profileId: "profile-same", handler: okHandler });
    const first = await brokerCall(a.session, act(stampedRequestId(), AUD_A, { action: "click" }));
    assert.equal(first.ok, true);
    const blocked = await brokerCall(b.session, act(stampedRequestId(), AUD_A, { action: "click" }));
    assert.equal(blocked.error.code, "MUTATION_JOURNAL_UNAVAILABLE");
    assert.equal(blocked.outcome, "not_started");
    assert.equal(b.firefox.requestsOfType("act").length, 0);
  });

  it("takes over a stale journal lock whose owner is dead", async () => {
    const roots = makeTempRoot();
    const first = await boot({ roots, keepRoots: true, profileId: "profile-stale", handler: okHandler });
    await brokerCall(first.session, act(stampedRequestId(), AUD_A, { action: "click" }));
    await first.firefox.kill();
    const lock = fs.readdirSync(roots.stateDir).find((name) => name.endsWith(".lock"));
    assert.ok(lock, "SIGKILL leaves the lock behind");
    const second = await boot({ roots, profileId: "profile-stale", handler: okHandler });
    const response = await brokerCall(second.session, act(stampedRequestId(), AUD_A, { action: "click" }));
    assert.equal(response.ok, true);
  });

  it("refuses timestamped request ids older than the replay horizon", async () => {
    const { firefox, session } = await boot({ handler: okHandler });
    const response = await brokerCall(session, act(stampedRequestId(8 * 24 * 60 * 60 * 1000), AUD_A, { action: "click" }));
    assert.equal(response.error.code, "REPLAY_HORIZON_EXPIRED");
    assert.equal(response.outcome, "not_started");
    assert.equal(firefox.requestsOfType("act").length, 0);
  });

  it("quarantines a corrupt journal and refuses older timestamped ids", async () => {
    const roots = makeTempRoot();
    const first = await boot({ roots, keepRoots: true, profileId: "profile-corrupt", handler: okHandler });
    await brokerCall(first.session, act(stampedRequestId(), AUD_A, { action: "click" }));
    await first.firefox.stop();
    const journal = fs.readdirSync(roots.stateDir).find((name) => /^mutation-journal-v2-.*\.json$/.test(name));
    fs.writeFileSync(path.join(roots.stateDir, journal), "{ not json");
    const second = await boot({ roots, profileId: "profile-corrupt", handler: okHandler });
    const stale = await brokerCall(second.session, act(stampedRequestId(60_000), AUD_A, { action: "click" }));
    assert.equal(stale.error.code, "REPLAY_HORIZON_EXPIRED");
    assert.ok(fs.readdirSync(roots.stateDir).some((name) => name.includes(".corrupt-")));
  });
});

describe("in-flight handling (F09)", () => {
  it("coalesces identical concurrent requests onto one companion dispatch", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { firefox, session } = await boot({
      handler: async () => { await gate; return { ok: true, result: { contexts: [] } }; },
    });
    const request = { id: "read-same-id-1", op: "list_contexts", audience_id: AUD_A, params: {} };
    const one = brokerCall(session, request);
    const two = brokerCall(session, request);
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const [a, b] = await Promise.all([one, two]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(firefox.requestsOfType("list_contexts").length, 1);
  });

  it("rejects a conflicting concurrent request id from another audience or with other params", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { session } = await boot({ handler: async () => { await gate; return { ok: true, result: {} }; } });
    const base = { id: "read-conflict-1", op: "snapshot", audience_id: AUD_A, params: { context_id: "tab:1" } };
    const first = brokerCall(session, base);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const otherAudience = await brokerCall(session, { ...base, audience_id: AUD_B });
    const otherParams = await brokerCall(session, { ...base, params: { context_id: "tab:2" } });
    assert.equal(otherAudience.error.code, "REQUEST_ID_CONFLICT");
    assert.equal(otherParams.error.code, "REQUEST_ID_CONFLICT");
    release();
    assert.equal((await first).ok, true);
  });

  it("reports in_flight, completed and unknown states through mutation_status", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { session } = await boot({ handler: async () => { await gate; return { ok: true, outcome: "completed", result: { outcome: "completed" } }; } });
    const id = stampedRequestId();
    const call = brokerCall(session, act(id, AUD_A, { action: "click" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const status = (audience, target = id) => brokerCall(session, { id: `status-${Math.random()}`, op: "mutation_status", audience_id: audience, params: { request_id: target } });
    assert.equal((await status(AUD_A)).result.state, "in_flight");
    assert.equal((await status(AUD_B)).result.state, "not_found", "other audiences cannot observe the request");
    release();
    await call;
    const done = await status(AUD_A);
    assert.equal(done.result.state, "completed");
    assert.equal(done.result.outcome, "completed");
    assert.equal((await status(AUD_A, stampedRequestId())).result.state, "not_found");
  });

  it("settles the journal from a late companion response after the waiter timed out", async () => {
    let releaseLate;
    const gate = new Promise((resolve) => { releaseLate = resolve; });
    const { session } = await boot({
      requestTimeoutMs: 150,
      handler: async () => { await gate; return { ok: true, outcome: "completed", result: { outcome: "completed" } }; },
    });
    const id = stampedRequestId();
    const timedOut = await brokerCall(session, act(id, AUD_A, { action: "click" }));
    assert.equal(timedOut.error.code, "BROKER_RESPONSE_TIMEOUT");
    assert.equal(timedOut.outcome, "outcome_unknown");
    const statusCall = () => brokerCall(session, { id: `s-${Math.random()}`, op: "mutation_status", audience_id: AUD_A, params: { request_id: id } });
    assert.equal((await statusCall()).result.state, "outcome_unknown");
    releaseLate();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await statusCall()).result.state, "completed");
  });
});

describe("protocol revision gate", () => {
  it("fails closed for every operation but status when the companion speaks another protocol", async () => {
    const { firefox, session } = await boot({ companionProtocol: 1, handler: async () => ({ ok: true, result: { protocol_version: 1 } }) });
    const read = await brokerCall(session, { id: "mismatch-read-1", op: "snapshot", audience_id: AUD_A, params: { context_id: "tab:1" } });
    assert.equal(read.error.code, "BROWSER_PROTOCOL_MISMATCH");
    assert.equal(read.outcome, "not_started");
    const write = await brokerCall(session, act(stampedRequestId(), AUD_A, { action: "click" }));
    assert.equal(write.error.code, "BROWSER_PROTOCOL_MISMATCH");
    assert.equal(firefox.requestsOfType("snapshot").length + firefox.requestsOfType("act").length, 0);
    const status = await brokerCall(session, { id: "mismatch-status-1", op: "status", audience_id: AUD_A, params: {} });
    assert.equal(status.ok, true);
    assert.equal(session.protocol_version, 2);
    assert.equal(firefox.session().companion_protocol_version, 1);
  });
});
