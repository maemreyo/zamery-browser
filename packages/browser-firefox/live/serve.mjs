// Starts the isolated live Firefox, opens the /colors fixture, auto-shares it once the given consumer id connects,
// prints one JSON line {sessionsDir, consumerId} and waits. For driving a REAL MCP host (e.g. Codex) against it.
//   node live/serve.mjs <consumer-id>
import { startLive } from "./live-env.mjs";

const consumerId = process.argv[2];
if (!consumerId) throw new Error("usage: serve.mjs <consumer-id>");
const live = await startLive();
const tab = await live.user("open_tab", { url: `${live.origin}/colors`, active: true });
await live.user("activate_tab", { tab_id: tab.id });
process.stdout.write(`${JSON.stringify({ sessionsDir: live.sessionsDir, consumerId, tabId: tab.id })}\n`);
let granted = false;
const timer = setInterval(async () => {
  if (granted) return;
  const status = await live.user("status").catch(() => null);
  if (status?.seen_audiences?.some((entry) => entry.audience_id === consumerId)) {
    const result = await live.user("grant", { audience_id: consumerId, tab_ids: [tab.id], duration: { mode: "session" } });
    granted = result.ok === true;
    process.stderr.write(`[serve] shared tab ${tab.id}: ${granted}\n`);
  }
}, 300);
const stop = async () => { clearInterval(timer); await live.cleanup(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
