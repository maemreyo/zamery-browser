#!/usr/bin/env node
// Prints the release-candidate tuple for the working tree as JSON. Every axis is its own field because they are
// different numbers on purpose (git SHA, npm package versions, companion version, signed XPI, wire protocol, ...).
//   node scripts/release-tuple.mjs [--xpi path/to/signed.xpi] [--codex-surface "<name build>"]
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const sh = (command, args, options = {}) => { try { return execFileSync(command, args, { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "ignore"], ...options }).trim(); } catch { return null; } };
const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

const companion = json("packages/browser-firefox/runtime/companion/manifest.json");
const stagedFiles = [...new Set([
  "manifest.json",
  ...(companion.background?.scripts ?? []),
  ...(companion.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
  companion.browser_action?.default_popup,
  companion.browser_action?.default_popup?.replace(/\.html$/, ".js"),
].filter(Boolean))].sort();
const sourceHash = crypto.createHash("sha256");
for (const file of stagedFiles) {
  sourceHash.update(file).update("\0").update(fs.readFileSync(path.join(root, "packages/browser-firefox/runtime/companion", file))).update("\0");
}

let signed = null;
const xpi = arg("--xpi");
if (xpi) {
  const bytes = fs.readFileSync(xpi);
  const manifest = sh("unzip", ["-p", xpi, "manifest.json"]);
  signed = {
    file: path.basename(xpi),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    manifestVersion: manifest ? JSON.parse(manifest).version : null,
    hasMozillaSignature: sh("unzip", ["-l", xpi])?.includes("META-INF/mozilla.rsa") ?? false,
  };
}

const firefoxPlist = "/Applications/Firefox.app/Contents/Info.plist";
const firefoxVersion = fs.existsSync(firefoxPlist) ? /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)</.exec(fs.readFileSync(firefoxPlist, "utf8"))?.[1] ?? null : null;
const packages = Object.fromEntries(["browser-provider", "browser-firefox", "browser-mcp", "pi-browser"].map((name) => {
  const pkg = json(`packages/${name}/package.json`);
  return [pkg.name, pkg.version];
}));

process.stdout.write(`${JSON.stringify({
  generatedAt: new Date().toISOString(),
  gitSha: sh("git", ["rev-parse", "HEAD"]),
  gitDirty: (sh("git", ["status", "--porcelain"]) ?? "").length > 0,
  npmPackages: packages,
  companion: { version: companion.version, extensionId: companion.browser_specific_settings?.gecko?.id, sourceSha256: sourceHash.digest("hex"), files: stagedFiles },
  signedXpi: signed,
  nativeWireProtocol: Number(/FIREFOX_BROKER_PROTOCOL_VERSION = (\d+)/.exec(fs.readFileSync(path.join(root, "packages/browser-firefox/src/protocol.ts"), "utf8"))?.[1]),
  browserProviderProtocol: 2,
  firefox: { installed: firefoxVersion, minimum: companion.browser_specific_settings?.gecko?.strict_min_version ?? null },
  node: process.versions.node,
  os: { platform: process.platform, release: os.release(), arch: process.arch, productVersion: sh("sw_vers", ["-productVersion"]) },
  codex: { cli: sh("codex", ["--version"]), surface: arg("--codex-surface") ?? null },
}, null, 2)}\n`);
