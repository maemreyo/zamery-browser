import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { firefoxCompatibilityFacts, installFirefoxNativeHost, runFirefoxDoctor } from "../dist/index.js";
import { FakeFirefox, makeTempRoot } from "./helpers/native-host-harness.mjs";
import { startStack } from "./helpers/stack-harness.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const EXT = "zamery-browser-firefox@zamery.local";
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

function tempHome() {
  const dir = fs.mkdtempSync(path.join("/tmp", "zq-home-"));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const byId = (report, id) => report.findings.filter((finding) => finding.id === id);
const worst = (report, id) => byId(report, id).map((finding) => finding.severity);

describe("doctor (offline evidence)", () => {
  it("reports a missing install with concrete fixes and does not write anything", async () => {
    const home = tempHome();
    const report = await runFirefoxDoctor({ homeDir: home, sessionsDir: path.join(home, "none"), firefoxAppPath: path.join(home, "no-app") });
    assert.equal(report.ok, false);
    assert.deepEqual(worst(report, "host-manifest"), ["fail"]);
    assert.match(byId(report, "host-manifest")[0].fix, /setup/);
    assert.deepEqual(worst(report, "live-session"), ["warn"]);
    assert.deepEqual(fs.readdirSync(home), [], "doctor is read-only");
  });

  it("passes manifest, launcher and host copy after setup, and flags each kind of drift", async () => {
    const home = tempHome();
    const plan = installFirefoxNativeHost({ extensionId: EXT, homeDir: home, nodePath: process.execPath });
    const opts = { homeDir: home, sessionsDir: path.join(home, "none"), firefoxAppPath: path.join(home, "no-app") };
    let report = await runFirefoxDoctor(opts);
    assert.deepEqual(worst(report, "host-manifest"), ["ok"]);
    assert.deepEqual(worst(report, "host-launcher"), ["ok"]);
    assert.deepEqual(worst(report, "host-copy"), ["ok"]);

    fs.appendFileSync(plan.installedHostPath, "\n// drift\n");
    report = await runFirefoxDoctor(opts);
    assert.deepEqual(worst(report, "host-copy"), ["warn"]);

    fs.writeFileSync(plan.launcherPath, fs.readFileSync(plan.launcherPath, "utf8").replace(process.execPath, "/nonexistent/node"));
    report = await runFirefoxDoctor(opts);
    assert.ok(worst(report, "host-launcher").includes("fail"));
    assert.match(byId(report, "host-launcher").find((f) => f.severity === "fail").message, /Node path no longer exists/);

    fs.chmodSync(plan.launcherPath, 0o600);
    assert.ok(worst(await runFirefoxDoctor(opts), "host-launcher").includes("fail"));

    fs.writeFileSync(plan.manifestPath, JSON.stringify({ ...plan.manifest, allowed_extensions: ["other@example"] }));
    assert.deepEqual(worst(await runFirefoxDoctor(opts), "host-manifest"), ["fail"]);
  });

  it("warns about a legacy plaintext journal without reading it", async () => {
    const home = tempHome();
    const state = path.join(home, "Library", "Application Support", "Zamery", "browser-firefox", "state");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "mutation-journal.json"), "LEGACY-SECRET-CANARY");
    const report = await runFirefoxDoctor({ homeDir: home, sessionsDir: path.join(home, "none") });
    assert.deepEqual(worst(report, "legacy-journal"), ["warn"]);
    assert.ok(!JSON.stringify(report).includes("LEGACY-SECRET-CANARY"));
  });

  it("verifies the companion from a profile add-on registry without naming other add-ons", async () => {
    const home = tempHome();
    const profile = path.join(home, "Library", "Application Support", "Firefox", "Profiles", "abc123.default-release");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "extensions.json"), JSON.stringify({ addons: [
      { id: "some-other-addon@example", version: "9", active: true, defaultLocale: { name: "PRIVATE-ADDON-NAME" } },
      { id: EXT, version: "0.2.0", active: true, signedState: 2 },
    ] }));
    const report = await runFirefoxDoctor({ homeDir: home, sessionsDir: path.join(home, "none") });
    const installed = byId(report, "companion-installed");
    assert.equal(installed.length, 1);
    assert.match(installed[0].message, /companion 0\.2\.0, enabled, signed/);
    assert.ok(!JSON.stringify(report).includes("PRIVATE-ADDON-NAME"));
    assert.ok(!JSON.stringify(report).includes("some-other-addon"));
  });

  it("rejects a Node outside the supported range", async () => {
    const home = tempHome();
    const report = await runFirefoxDoctor({ homeDir: home, nodeVersion: "20.11.0", sessionsDir: path.join(home, "none") });
    assert.deepEqual(worst(report, "node"), ["fail"]);
  });

  it("flags a Firefox older than the minimum", async () => {
    const home = tempHome();
    const app = path.join(home, "Firefox.app", "Contents");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "Info.plist"), "<dict><key>CFBundleShortVersionString</key><string>128.0</string></dict>");
    const report = await runFirefoxDoctor({ homeDir: home, firefoxAppPath: path.join(home, "Firefox.app"), sessionsDir: path.join(home, "none") });
    assert.deepEqual(worst(report, "firefox-app"), ["fail"]);
  });
});

describe("doctor (live handshake)", () => {
  it("reports what the running companion says, without registering as a shareable agent", async () => {
    const stack = await startStack();
    cleanups.push(() => stack.stop());
    const home = tempHome();
    const report = await runFirefoxDoctor({ homeDir: home, sessionsDir: path.join(stack.roots.runtimeDir, "sessions") });
    assert.equal(report.sessions.length, 1);
    const [session] = report.sessions;
    assert.equal(session.observed.firefoxVersion, "157.0");
    assert.equal(session.observed.companionVersion, "0.1.4-test");
    assert.equal(session.observed.authorizationState, "revoked");
    assert.equal(session.observed.features.tab_groups_api, true);
    assert.equal(session.companionProtocol, 2);
    assert.equal(session.journalSchema, 2);
    assert.deepEqual(worst(report, "handshake"), ["ok"]);
    const popup = await stack.company.popup({ type: "zamery_browser_firefox_auth_status" });
    assert.equal(popup.seen_audiences.length, 0, "the doctor probe is not offered to the user as an agent");
    assert.ok(!JSON.stringify(report).includes(session.profileIdPrefix + "-"), "only a short profile prefix is reported");
  });

  it("fails on a companion/host protocol mismatch and says how to fix it", async () => {
    const roots = makeTempRoot();
    const firefox = new FakeFirefox({ roots, companionProtocol: 1, handler: async () => ({ ok: true, result: { protocol_version: 1, authorization: { protocol_compatible: false } } }) });
    await firefox.start();
    cleanups.push(async () => { await firefox.kill(); roots.cleanup(); });
    const home = tempHome();
    const report = await runFirefoxDoctor({ homeDir: home, sessionsDir: path.join(roots.runtimeDir, "sessions") });
    assert.equal(report.ok, false);
    const protocol = byId(report, "protocol");
    assert.ok(protocol.some((finding) => finding.severity === "fail" && /expects 2/.test(finding.message) && /Install a companion/.test(finding.fix)));
  });

  it("does not guess between several live sessions", async () => {
    const a = await startStack({ profileId: "profile-a" });
    cleanups.push(() => a.stop());
    const sessionsDir = path.join(a.roots.runtimeDir, "sessions");
    const second = new FakeFirefox({ roots: { ...a.roots, runtimeDir: a.roots.runtimeDir, stateDir: path.join(a.roots.root, "s2") }, profileId: "profile-b", handler: async () => ({ ok: true, result: {} }) });
    await second.start();
    cleanups.push(() => second.kill());
    const report = await runFirefoxDoctor({ homeDir: tempHome(), sessionsDir, handshake: false });
    assert.equal(report.sessions.length, 2);
    assert.ok(byId(report, "live-session").some((finding) => /several Firefox profiles/.test(finding.message)));
  });
});

describe("setup and doctor CLI", () => {
  const run = (home, args) => spawnSync(process.execPath, [CLI, ...args], {
    env: { PATH: process.env.PATH, HOME: home, ZAMERY_BROWSER_FIREFOX_RUNTIME_DIR: path.join(home, "runtime") },
    encoding: "utf8",
  });

  it("dry-run changes nothing; setup installs; a different manifest is never silently overwritten; --force keeps a backup", () => {
    const home = tempHome();
    const dry = run(home, ["setup", "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Would write/);
    assert.equal(fs.existsSync(path.join(home, "Library")), false);

    const real = run(home, ["setup"]);
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stdout, /Restart Firefox once/);
    assert.match(real.stdout, new RegExp(`companion protocol ${firefoxCompatibilityFacts().companionProtocol}`));
    const manifestPath = path.join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts", "com.zamery.browser_firefox.json");
    const original = fs.readFileSync(manifestPath, "utf8");
    assert.equal(run(home, ["setup"]).status, 0, "re-running an identical setup is fine");

    fs.writeFileSync(manifestPath, JSON.stringify({ name: "com.zamery.browser_firefox", path: "/somewhere/else", type: "stdio", allowed_extensions: ["x@y"] }));
    const refused = run(home, ["setup"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing to overwrite/);
    assert.match(fs.readFileSync(manifestPath, "utf8"), /somewhere\/else/);

    const forced = run(home, ["setup", "--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(fs.readFileSync(manifestPath, "utf8"), original);
    assert.ok(fs.readdirSync(path.dirname(manifestPath)).some((name) => name.includes(".bak-")), "previous manifest preserved");
  });

  it("doctor --json is machine readable and exits non-zero on blocking problems", () => {
    const home = tempHome();
    const result = run(home, ["doctor", "--json"]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((finding) => finding.id === "host-manifest" && finding.severity === "fail"));
    run(home, ["setup"]);
    const after = JSON.parse(run(home, ["doctor", "--json"]).stdout);
    assert.ok(after.findings.some((finding) => finding.id === "host-manifest" && finding.severity === "ok"));
    void execFileSync;
  });

  it("rejects unknown commands", () => {
    const result = run(tempHome(), ["frobnicate"]);
    assert.equal(result.status, 2);
  });
});
