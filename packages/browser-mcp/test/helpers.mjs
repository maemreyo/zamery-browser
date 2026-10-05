import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFirefoxBrowserProviderV2, createFirefoxRequestId } from "@zamery/browser-firefox";

import { createBrowserMcpServer } from "../dist/index.js";
import { startStack } from "../../browser-firefox/test/helpers/stack-harness.mjs";

export const AUD = "mcp-test-consumer-0001";

export async function connect(options) {
  const handle = createBrowserMcpServer({ version: "0.0.0-test", ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientTransport);
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });
  return { handle, client, call, async close() { await client.close(); await handle.close(); } };
}

/** Full stack: MCP server -> real FirefoxBrowserProviderV2 -> broker -> real native host -> real companion. */
export async function connectStack(stackOptions = {}) {
  const stack = await startStack(stackOptions);
  const sessionsDir = path.join(stack.roots.runtimeDir, "sessions");
  const mcp = await connect({
    requestIdFactory: () => createFirefoxRequestId(),
    provider: ({ clientName }) => createFirefoxBrowserProviderV2({ sessionsDir, audienceId: AUD, autoClaim: false, clientLabel: `MCP: ${clientName ?? "?"}` }),
  });
  return {
    ...mcp,
    stack,
    async grant(extra = {}) {
      await mcp.call("browser_status"); // registers the agent so the user can pick it in the popup
      const result = await stack.company.popup({ type: "zamery_browser_firefox_grant", audience_id: AUD, tab_ids: [1], duration: { mode: "session" }, ...extra });
      if (result?.ok !== true) throw new Error(`grant failed: ${JSON.stringify(result)}`);
      return result;
    },
    async close() { await mcp.close(); await stack.stop(); },
  };
}

export const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");
