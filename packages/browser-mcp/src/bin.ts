#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFirefoxBrowserProviderV2, createFirefoxRequestId } from "@zamery/browser-firefox";

import { loadOrCreateConsumerId } from "./consumer-id.js";
import { createBrowserMcpServer } from "./server.js";

const ALLOWED_PROVIDERS = new Set(["firefox"]);

function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function main(): void {
  // Providers are an allowlist chosen by the operator, never by the model or by page content.
  const requested = process.env.ZAMERY_BROWSER_MCP_PROVIDER?.trim() || "firefox";
  if (!ALLOWED_PROVIDERS.has(requested)) {
    process.stderr.write(`[zamery-browser-mcp] unsupported provider "${requested}" (allowed: ${[...ALLOWED_PROVIDERS].join(", ")})\n`);
    process.exit(2);
  }
  const consumerId = loadOrCreateConsumerId({
    ...(process.env.ZAMERY_BROWSER_MCP_STATE_DIR ? { stateDir: process.env.ZAMERY_BROWSER_MCP_STATE_DIR } : {}),
    ...(process.env.ZAMERY_BROWSER_MCP_CONSUMER_ID ? { override: process.env.ZAMERY_BROWSER_MCP_CONSUMER_ID } : {}),
  });
  const browserInstanceId = process.env.ZAMERY_BROWSER_MCP_BROWSER_INSTANCE_ID?.trim();
  const sessionsDir = process.env.ZAMERY_BROWSER_MCP_SESSIONS_DIR?.trim();

  // The provider is created lazily so initialize returns immediately, before Firefox or any grant exists.
  const handle = createBrowserMcpServer({
    version: packageVersion(),
    requestIdFactory: () => createFirefoxRequestId(),
    provider: ({ clientName }) => createFirefoxBrowserProviderV2({
      audienceId: consumerId,
      clientLabel: clientName ? `MCP: ${clientName}` : "MCP client",
      ...(browserInstanceId ? { browserInstanceId } : {}),
      ...(sessionsDir ? { sessionsDir } : {}),
    }),
  });

  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = (code: number): void => {
    if (closing) return;
    closing = true;
    // Release our claim and local resources; Firefox and the shared native host keep running.
    const timer = setTimeout(() => process.exit(code), 2_000);
    timer.unref();
    void handle.close().finally(() => process.exit(code));
  };
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("close", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[zamery-browser-mcp] uncaught: ${error?.stack || error}\n`);
    shutdown(1);
  });

  void handle.server.connect(transport).then(
    () => process.stderr.write(`[zamery-browser-mcp] ready (consumer ${consumerId})\n`),
    (error: unknown) => {
      process.stderr.write(`[zamery-browser-mcp] failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    },
  );
}

main();
