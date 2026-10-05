import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { startStack } from "../../browser-firefox/test/helpers/stack-harness.mjs";
import { textOf } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join("/tmp", `${label}-`));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function spawnClient({ stateDir, sessionsDir, consumerId, env = {} }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      ZAMERY_BROWSER_MCP_STATE_DIR: stateDir,
      ZAMERY_BROWSER_MCP_SESSIONS_DIR: sessionsDir,
      ...(consumerId ? { ZAMERY_BROWSER_MCP_CONSUMER_ID: consumerId } : {}),
      ...env,
    },
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const client = new Client({ name: "codex-like-host", version: "1.0.0" });
  const started = performance.now();
  await client.connect(transport);
  const initializeMs = performance.now() - started;
  const handle = {
    client,
    initializeMs,
    stderr: () => stderr,
    pid: () => transport.pid,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    async close() { await client.close().catch(() => undefined); },
  };
  cleanups.push(() => handle.close());
  return handle;
}

describe("stdio server process", () => {
  it("initializes immediately with no Firefox and no grant, and exposes status", async () => {
    const mcp = await spawnClient({ stateDir: tempDir("zq-mcp-state"), sessionsDir: tempDir("zq-mcp-sessions") });
    assert.ok(mcp.initializeMs < 3_000, `initialize took ${mcp.initializeMs}ms (Codex waits 10s by default)`);
    const { tools } = await mcp.client.listTools();
    assert.ok(tools.some((tool) => tool.name === "browser_status"));
    const status = await mcp.call("browser_status");
    assert.equal(status.structuredContent.connected, false);
    assert.match(textOf(status), /Firefox is not connected/);
  });

  it("keeps a stable consumer id across restarts and never writes to stdout besides MCP frames", async () => {
    const stateDir = tempDir("zq-mcp-state");
    const sessionsDir = tempDir("zq-mcp-sessions");
    const first = await spawnClient({ stateDir, sessionsDir });
    await first.call("browser_status");
    const id = fs.readFileSync(path.join(stateDir, "consumer-id"), "utf8").trim();
    assert.match(id, /^mcp-[0-9a-f-]{36}$/);
    assert.equal((fs.statSync(path.join(stateDir, "consumer-id")).mode & 0o777), 0o600);
    assert.match(first.stderr(), new RegExp(id));
    await first.close();
    const second = await spawnClient({ stateDir, sessionsDir });
    await second.call("browser_status");
    assert.equal(fs.readFileSync(path.join(stateDir, "consumer-id"), "utf8").trim(), id);
  });

  it("rejects an unknown provider selection instead of loading arbitrary modules", async () => {
    await assert.rejects(spawnClient({ stateDir: tempDir("zq-mcp-state"), sessionsDir: tempDir("zq-mcp-sessions"), env: { ZAMERY_BROWSER_MCP_PROVIDER: "/tmp/evil.mjs" } }));
  });

  it("recovers from an MCP child crash: a new child under the same consumer id keeps the grant, with fresh observations", async () => {
    const stack = await startStack();
    cleanups.push(() => stack.stop());
    const consumerId = "mcp-crash-recovery-0001";
    const opts = { stateDir: tempDir("zq-mcp-state"), sessionsDir: path.join(stack.roots.runtimeDir, "sessions"), consumerId };

    const first = await spawnClient(opts);
    await first.call("browser_status"); // registers the agent
    const granted = await stack.company.popup({ type: "zamery_browser_firefox_grant", audience_id: consumerId, tab_ids: [1], duration: { mode: "session" } });
    assert.equal(granted.ok, true, JSON.stringify(granted));
    const snapshot = await first.call("browser_snapshot", { context_id: "tab:1" });
    assert.equal(snapshot.structuredContent.claim.claimed, true);
    const click = await first.call("browser_click", { context_id: "tab:1", observation_id: snapshot.structuredContent.observation_id, ref: "e1" });
    assert.equal(click.isError, undefined, textOf(click));

    process.kill(first.pid(), "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await spawnClient(opts);
    const status = await second.call("browser_status");
    assert.equal(status.structuredContent.authorization.state, "granted");
    // The new process has no observations: old refs are unusable and the agent must look again.
    const stale = await second.call("browser_click", { context_id: "tab:1", observation_id: snapshot.structuredContent.observation_id, ref: "e1" });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.error.reason, "observation_unknown");
    const fresh = await second.call("browser_snapshot", { context_id: "tab:1" });
    assert.equal(fresh.structuredContent.claim.claimed, true);
    const again = await second.call("browser_click", { context_id: "tab:1", observation_id: fresh.structuredContent.observation_id, ref: "e1" });
    assert.equal(again.isError, undefined, textOf(again));
  });

  it("releases its claim and exits cleanly when the host closes stdin, leaving Firefox untouched", async () => {
    const stack = await startStack();
    cleanups.push(() => stack.stop());
    const consumerId = "mcp-clean-exit-00001";
    const mcp = await spawnClient({ stateDir: tempDir("zq-mcp-state"), sessionsDir: path.join(stack.roots.runtimeDir, "sessions"), consumerId });
    await mcp.call("browser_status");
    await stack.company.popup({ type: "zamery_browser_firefox_grant", audience_id: consumerId, tab_ids: [1], duration: { mode: "session" } });
    const claimed = await mcp.call("browser_snapshot", { context_id: "tab:1" });
    assert.equal(claimed.structuredContent.claim.claimed, true);
    assert.equal((await stack.company.popup({ type: "zamery_browser_firefox_auth_status" })).control.state, "agent_claimed");
    await mcp.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await stack.company.popup({ type: "zamery_browser_firefox_auth_status" })).control.state, "shared_idle", "claim released on teardown");
    assert.ok(stack.company.tabs.has(1) && stack.company.tabs.has(2), "no tab was touched");
    assert.equal((await stack.company.popup({ type: "zamery_browser_firefox_auth_status" })).state, "granted", "the user's grant stays");
  });
});
