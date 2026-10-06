// Long-lived fake Firefox (real native host + real companion code, fake browser APIs) for driving a REAL
// MCP host such as Codex against @zamery/browser-mcp without touching the user's browser.
//   node test/acceptance/fake-firefox.mjs <consumer-id>
// Prints one JSON line with the sessions dir, auto-shares tab 1 once that agent connects, then waits.
import fs from "node:fs";
import path from "node:path";

import { startStack } from "../../../browser-firefox/test/helpers/stack-harness.mjs";
import { pageScript } from "../../../browser-firefox/test/helpers/companion-harness.mjs";

const consumerId = process.argv[2];
if (!consumerId) throw new Error("usage: fake-firefox.mjs <consumer-id>");
const jpeg = fs.readFileSync(new URL("../../../browser-firefox/test/fixtures/quadrants.jpg", import.meta.url));

const page = pageScript({
  snapshotNodes: [
    { node_id: "n1", role: "textbox", name: "Search", tag: "input", type: "text" },
    { node_id: "n2", role: "button", name: "Go", tag: "button" },
  ],
});
const stack = await startStack({
  tabs: [{ id: 1, url: "https://fixture.test/colors", title: "Color fixture", active: true }, { id: 2, url: "https://other.test/", title: "Unshared", active: false }],
  pages: { 1: page },
});
stack.company.state.captureFor = () => `data:image/jpeg;base64,${jpeg.toString("base64")}`;
process.stdout.write(`${JSON.stringify({ sessionsDir: path.join(stack.roots.runtimeDir, "sessions"), consumerId })}\n`);

let granted = false;
const timer = setInterval(async () => {
  if (granted) return;
  const status = await stack.company.popup({ type: "zamery_browser_firefox_auth_status" });
  if (status?.seen_audiences?.some((entry) => entry.audience_id === consumerId)) {
    const result = await stack.company.popup({ type: "zamery_browser_firefox_grant", audience_id: consumerId, tab_ids: [1], duration: { mode: "session" } });
    granted = result?.ok === true;
    process.stderr.write(`[fake-firefox] auto-share ${granted ? "granted" : `failed ${JSON.stringify(result)}`}\n`);
  }
}, 200);

const stop = async () => { clearInterval(timer); await stack.stop(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
