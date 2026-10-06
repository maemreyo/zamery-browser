// Orchestrates an isolated live-Firefox acceptance environment:
//  - temp profile, headless (unless LIVE_HEADED=1), -no-remote, never the user's running Firefox or profile
//  - a differently-named native host + extension id (additive manifest, removed on cleanup)
//  - a local HTTP fixture server
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sendFirefoxBrokerRequest } from "../dist/client.js";
import { installFirefoxNativeHost } from "../dist/index.js";
import { listLiveFirefoxSessions } from "../dist/session.js";
import { ACCEPTANCE_EXTENSION_ID, ACCEPTANCE_HOST_NAME, stageAcceptanceCompanion } from "./stage-companion.mjs";
import { startFixtureServer } from "./fixtures-server.mjs";

export const AUDIENCE = "live-acceptance-agent-0001";
const FIREFOX = process.env.LIVE_FIREFOX_BIN ?? "/Applications/Firefox.app/Contents/MacOS/firefox";

export async function startLive(options = {}) {
  const root = options.root ?? "/tmp/zq-live";
  const keepProfile = options.keepProfile === true;
  if (!keepProfile) fs.rmSync(root, { recursive: true, force: true });
  const dirs = { root, rt: path.join(root, "rt"), state: path.join(root, "state"), profile: path.join(root, "profile"), companion: path.join(root, "companion"), install: path.join(root, "install") };
  for (const dir of [dirs.rt, dirs.state, dirs.profile]) fs.mkdirSync(dir, { recursive: true });

  const fixtures = await startFixtureServer();
  stageAcceptanceCompanion(dirs.companion);
  const plan = installFirefoxNativeHost({
    hostName: ACCEPTANCE_HOST_NAME,
    extensionId: ACCEPTANCE_EXTENSION_ID,
    runtimeDir: dirs.install,
    nodePath: process.execPath,
    force: true,
    launcherEnv: { ZAMERY_BROWSER_FIREFOX_RUNTIME_DIR: dirs.rt, ZAMERY_BROWSER_FIREFOX_STATE_DIR: dirs.state },
  });

  const env = { ...process.env, ZAMERY_BROWSER_FIREFOX_RUNTIME_DIR: dirs.rt };
  let firefox = null;
  const sessionsDir = path.join(dirs.rt, "sessions");
  const log = fs.openSync(path.join(root, "webext.log"), "a");

  async function launch() {
    firefox = spawn("npx", [
      "--yes", "web-ext@10.6.0", "run",
      "--source-dir", dirs.companion,
      "--firefox", FIREFOX,
      "--firefox-profile", dirs.profile,
      "--keep-profile-changes", "--no-reload", "--no-input",
      "--arg=-no-remote", ...(process.env.LIVE_HEADED === "1" ? [] : ["--arg=-headless"]), "--arg=-marionette",
      "--start-url", `http://127.0.0.1:${fixtures.port}/`,
    ], { cwd: root, env, stdio: ["ignore", log, log], detached: true });
    firefox.unref();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const sessions = listLiveFirefoxSessions({ sessionsDir });
      const ready = sessions.find((session) => session.browser_instance_id);
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`no live acceptance session appeared; see ${path.join(root, "webext.log")}`);
  }

  async function kill() {
    if (!firefox) return;
    try { process.kill(-firefox.pid, "SIGTERM"); } catch { /* already gone */ }
    // web-ext starts Firefox as a child; make sure that profile's Firefox is gone.
    await new Promise((resolve) => {
      const child = spawn("pkill", ["-f", `-profile ${dirs.profile}`], { stdio: "ignore" });
      child.on("exit", resolve);
    });
    firefox = null;
    for (let index = 0; index < 40; index += 1) {
      if (listLiveFirefoxSessions({ sessionsDir, maxAgeMs: 2_000 }).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  const live = {
    dirs, fixtures, plan, sessionsDir,
    origin: `http://127.0.0.1:${fixtures.port}`,
    altOrigin: `http://localhost:${fixtures.port}`,
    session: await launch(),
    currentSession() {
      return listLiveFirefoxSessions({ sessionsDir }).find((session) => session.browser_instance_id) ?? null;
    },
    async waitSession(predicate = () => true, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const session = live.currentSession();
        if (session && predicate(session)) return session;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error("timed out waiting for a live session");
    },
    /** Perform the user's side (or fixture setup) in real Firefox. */
    async user(op, params = {}) {
      const session = live.currentSession();
      if (!session) throw new Error("no live session");
      const response = await sendFirefoxBrokerRequest(session, `acceptance_${op}`, params, { audienceId: AUDIENCE, timeoutMs: 20_000 });
      if (!response.ok) throw new Error(`acceptance_${op} failed: ${JSON.stringify(response.error)}`);
      return response.result;
    },
    async restartFirefox() {
      await kill();
      live.session = await launch();
      return live.session;
    },
    async relaunchAfterKill() { return launch(); },
    kill,
    async cleanup() {
      await kill();
      await fixtures.close();
      try { fs.unlinkSync(plan.manifestPath); } catch { /* already removed */ }
    },
  };
  void os;
  return live;
}
