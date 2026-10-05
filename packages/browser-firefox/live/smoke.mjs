import { startLive, AUDIENCE } from "./live-env.mjs";
const live = await startLive();
try {
  console.log("session", live.session.session_id, live.session.extension_version, "protocols", live.session.protocol_version, live.session.companion_protocol_version);
  console.log("tabs", JSON.stringify(await live.user("tabs")));
  console.log("status", JSON.stringify((await live.user("status")).state));
} finally {
  await live.cleanup();
}
