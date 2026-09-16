import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FIREFOX_NATIVE_HOST_NAME = "com.zamery.browser_firefox";

export interface FirefoxNativeHostInstallPlan {
  hostName: string;
  extensionIds: readonly string[];
  sourceHostPath: string;
  installedHostPath: string;
  launcherPath: string;
  stderrLogPath: string;
  manifestPath: string;
  manifest: {
    name: string;
    description: string;
    path: string;
    type: "stdio";
    allowed_extensions: string[];
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildFirefoxNativeHostInstallPlan(options: {
  extensionId?: string;
  extensionIds?: readonly string[];
  hostName?: string;
  homeDir?: string;
  nodePath?: string;
}): FirefoxNativeHostInstallPlan {
  const homeDir = options.homeDir ?? os.homedir();
  const hostName = options.hostName ?? DEFAULT_FIREFOX_NATIVE_HOST_NAME;
  const extensionIds = options.extensionIds ?? (options.extensionId ? [options.extensionId] : []);
  if (extensionIds.length === 0) throw new Error("at least one Firefox companion extension ID is required");
  if (new Set(extensionIds).size !== extensionIds.length) throw new Error("duplicate Firefox companion extension IDs are not allowed");
  const packageRuntimePath = fileURLToPath(new URL("../runtime/native-host.mjs", import.meta.url));
  const runtimeDir = path.join(homeDir, "Library", "Application Support", "Zamery", "browser-firefox");
  const binDir = path.join(runtimeDir, "bin");
  const installedHostPath = path.join(binDir, "native-host.mjs");
  const launcherPath = path.join(binDir, "native-host-launcher.sh");
  const stderrLogPath = path.join(runtimeDir, "native-host-stderr.log");
  const manifestDir = path.join(homeDir, "Library", "Application Support", "Mozilla", "NativeMessagingHosts");
  const manifestPath = path.join(manifestDir, `${hostName}.json`);
  const manifest = {
    name: hostName,
    description: "Zamery BrowserProvider Firefox native host",
    path: launcherPath,
    type: "stdio" as const,
    allowed_extensions: [...extensionIds],
  };

  return {
    hostName,
    extensionIds: [...extensionIds],
    sourceHostPath: packageRuntimePath,
    installedHostPath,
    launcherPath,
    stderrLogPath,
    manifestPath,
    manifest,
  };
}

export function installFirefoxNativeHost(options: {
  extensionId?: string;
  extensionIds?: readonly string[];
  hostName?: string;
  homeDir?: string;
  nodePath?: string;
  force?: boolean;
  dryRun?: boolean;
}): FirefoxNativeHostInstallPlan {
  const plan = buildFirefoxNativeHostInstallPlan(options);
  if (options.dryRun) return plan;

  const runtimeDir = path.dirname(path.dirname(plan.installedHostPath));
  const binDir = path.dirname(plan.installedHostPath);
  const manifestDir = path.dirname(plan.manifestPath);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(manifestDir, { recursive: true });

  if (fs.existsSync(plan.manifestPath) && !options.force) {
    let existing: unknown;
    try {
      existing = JSON.parse(fs.readFileSync(plan.manifestPath, "utf8"));
    } catch {
      existing = undefined;
    }
    if (JSON.stringify(existing) !== JSON.stringify(plan.manifest)) {
      throw new Error(`refusing to overwrite different Native Messaging manifest: ${plan.manifestPath}`);
    }
  }

  fs.copyFileSync(plan.sourceHostPath, plan.installedHostPath);
  fs.chmodSync(plan.installedHostPath, 0o700);

  const nodePath = options.nodePath ?? process.execPath;
  const launcher = [
    "#!/bin/sh",
    `printf '%s\\n' \"[zamery-browser-firefox-launcher] $(date '+%Y-%m-%dT%H:%M:%S%z') pid=$$ args=$*\" >>${shellQuote(plan.stderrLogPath)}`,
    `exec ${shellQuote(nodePath)} ${shellQuote(plan.installedHostPath)} 2>>${shellQuote(plan.stderrLogPath)}`,
    "",
  ].join("\n");
  fs.writeFileSync(plan.launcherPath, launcher, { mode: 0o700 });
  fs.chmodSync(plan.launcherPath, 0o700);

  fs.writeFileSync(plan.manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(plan.manifestPath, 0o600);
  return plan;
}
