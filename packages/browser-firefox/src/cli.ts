#!/usr/bin/env node
import { parseArgs } from "node:util";

import { FIREFOX_COMPANION_PRODUCTION_EXTENSION_ID } from "./companion.js";
import { firefoxCompatibilityFacts } from "./compat.js";
import { formatDoctorReport, runFirefoxDoctor } from "./doctor.js";
import { installFirefoxNativeHost } from "./install.js";

const USAGE = `Usage: zamery-browser-firefox <command> [options]

Commands:
  doctor   Non-mutating health report (add --json for machine output).
  setup    Install the Native Messaging host for the signed companion.
           --dry-run      Print what would be written and change nothing.
           --force        Replace a different existing manifest (a backup is kept).
           --node-path P  Node binary the host launcher should use (default: this Node).

Setup never launches, restarts or replaces Firefox, and never installs the add-on for you.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "node-path": { type: "string" },
    },
    allowPositionals: false,
  });

  if (command === "doctor") {
    const report = await runFirefoxDoctor();
    process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
    return report.ok ? 0 : 1;
  }

  if (command === "setup") {
    const facts = firefoxCompatibilityFacts();
    try {
      const plan = installFirefoxNativeHost({
        extensionId: FIREFOX_COMPANION_PRODUCTION_EXTENSION_ID,
        dryRun: values["dry-run"] === true,
        force: values.force === true,
        ...(values["node-path"] ? { nodePath: values["node-path"] } : {}),
      });
      const verb = values["dry-run"] ? "Would write" : "Wrote";
      process.stdout.write([
        `${verb}:`,
        `  native host manifest  ${plan.manifestPath}`,
        `  launcher              ${plan.launcherPath}`,
        `  host script           ${plan.installedHostPath}`,
        "",
        "Next steps:",
        `  1. Install or update the Zamery Browser Companion (bundled with this package: ${facts.bundledCompanionVersion}, companion protocol ${facts.companionProtocol}).`,
        "     Use the signed XPI listed for this release; do not install an unsigned build in a release Firefox.",
        "  2. Restart Firefox once so it starts the new host (setup never restarts it for you).",
        "  3. Run `zamery-browser-firefox doctor`.",
        "",
      ].join("\n"));
      return 0;
    } catch (error) {
      process.stderr.write(`setup failed: ${(error as Error).message}\n`);
      return 1;
    }
  }

  process.stderr.write(`unknown command: ${command}\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
