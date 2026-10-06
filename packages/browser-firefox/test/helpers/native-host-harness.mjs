// Test harness that plays the Firefox side of Native Messaging for a real native-host.mjs process
// and the consumer side of the UDS broker. It crosses the same boundaries production does.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_PATH = fileURLToPath(new URL("../../runtime/native-host.mjs", import.meta.url));

export function makeTempRoot(label = "zq") {
  // Unix socket paths are limited to ~104 bytes on macOS, so keep the root short.
  const root = fs.mkdtempSync(path.join("/tmp", `${label}-`));
  return {
    root,
    runtimeDir: path.join(root, "r"),
    stateDir: path.join(root, "s"),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

export function stampedRequestId(ageMs = 0) {
  return `zq1-${(Date.now() - ageMs).toString(36).padStart(8, "0")}-${crypto.randomBytes(9).toString("base64url")}`;
}

export function readAllFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    const full = path.join(dir, String(name));
    try {
      if (fs.statSync(full).isFile()) out.push({ path: full, text: fs.readFileSync(full, "utf8") });
    } catch {}
  }
  return out;
}

export class FakeFirefox {
  constructor({ roots, profileId = "profile-a", companionProtocol = 2, handler }) {
    this.roots = roots;
    this.profileId = profileId;
    this.companionProtocol = companionProtocol;
    this.handler = handler || (async () => ({ ok: true, result: {} }));
    this.received = [];
    this.stderr = "";
    this.buffer = Buffer.alloc(0);
    this.silent = new Set();
  }

  async start() {
    this.child = spawn(process.execPath, [HOST_PATH], {
      env: {
        ...process.env,
        ZAMERY_BROWSER_FIREFOX_RUNTIME_DIR: this.roots.runtimeDir,
        ZAMERY_BROWSER_FIREFOX_STATE_DIR: this.roots.stateDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
    this.hostStatus = new Promise((resolve) => { this.resolveHostStatus = resolve; });
    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.hostStatusMessage = await this.hostStatus;
    this.hello();
    await this.waitForSession();
    return this;
  }

  hello(overrides = {}) {
    this.send({
      type: "hello",
      protocol_version: this.companionProtocol,
      extension_id: "zamery-browser-firefox@zamery.local",
      extension_version: "0.0.0-test",
      profile_id: this.profileId,
      browser_instance_id: `browser-${this.profileId}`,
      ...overrides,
    });
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(4, 4 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(4 + length);
      if (message.type === "host_status") { this.resolveHostStatus?.(message); continue; }
      this.received.push(message);
      if (this.onMessage) { this.onMessage(message); continue; }
      if (message.type === "request") void this.#answer(message);
    }
  }

  async #answer(message) {
    if (this.silent.has(message.id)) return;
    const reply = await this.handler(message, this);
    if (reply === null) return;
    this.send({ type: "response", id: message.id, ...reply });
  }

  async waitForSessionReal(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = this.session();
      if (session?.browser_instance_id) return session;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("host never received the companion hello");
  }

  async waitForSession(timeoutMs = 5_000) {
    const sessionsDir = path.join(this.roots.runtimeDir, "sessions");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = this.session();
      if (session?.browser_instance_id) return session;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`host session did not appear in ${sessionsDir}`);
  }

  session() {
    const sessionsDir = path.join(this.roots.runtimeDir, "sessions");
    try {
      for (const name of fs.readdirSync(sessionsDir).filter((entry) => entry.endsWith(".json"))) {
        const parsed = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), "utf8"));
        // A SIGKILLed host leaves its receipt behind; only trust the receipt of our own child.
        if (parsed.host_pid === this.child.pid) return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  requestsOfType(op) {
    return this.received.filter((message) => message.type === "request" && message.op === op);
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    await this.exited;
  }

  async kill() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill("SIGKILL");
    await this.exited;
  }
}

export function brokerCall(session, request, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(session.socket_path);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("broker call timeout")); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
