// Minimal Marionette client (Firefox's WebDriver backend). Its element commands synthesize *trusted* input
// events, which is what lets the live run prove human-gesture detection (extension scripts cannot forge isTrusted).
import net from "node:net";

export async function connectMarionette(port = 2828, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let socket;
  while (Date.now() < deadline) {
    try {
      socket = await new Promise((resolve, reject) => {
        const candidate = net.createConnection({ host: "127.0.0.1", port }, () => resolve(candidate));
        candidate.once("error", reject);
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!socket) throw new Error(`Marionette did not open on ${port}`);

  let buffer = Buffer.alloc(0);
  const waiting = new Map();
  let handshake;
  const handshakeReady = new Promise((resolve) => { handshake = resolve; });
  let nextId = 1;
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const colon = buffer.indexOf(":");
      if (colon < 0) return;
      const length = Number(buffer.subarray(0, colon).toString("ascii"));
      if (buffer.length < colon + 1 + length) return;
      const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString("utf8"));
      buffer = buffer.subarray(colon + 1 + length);
      if (!Array.isArray(message)) { handshake(message); continue; }
      const [, id, error, result] = message;
      const entry = waiting.get(id);
      if (entry) { waiting.delete(id); error ? entry.reject(new Error(`${error.error}: ${error.message}`)) : entry.resolve(result); }
    }
  });
  await handshakeReady;

  const send = (name, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    const body = JSON.stringify([0, id, name, params]);
    socket.write(`${Buffer.byteLength(body)}:${body}`);
  });
  await send("WebDriver:NewSession", { capabilities: {} });

  const element = async (selector) => {
    const found = await send("WebDriver:FindElement", { using: "css selector", value: selector });
    const value = found.value ?? found;
    return value["element-6066-11e4-a52e-4f735466cecf"] ?? Object.values(value)[0];
  };
  return {
    send,
    /** Switch to the tab whose URL contains `fragment`, without focusing/activating it. */
    async switchToUrl(fragment) {
      for (const handle of await send("WebDriver:GetWindowHandles")) {
        await send("WebDriver:SwitchToWindow", { handle, focus: false });
        const url = await send("WebDriver:GetCurrentURL");
        if (String(url.value ?? url).includes(fragment)) return handle;
      }
      throw new Error(`no tab with url containing ${fragment}`);
    },
    async type(selector, text) { await send("WebDriver:ElementSendKeys", { id: await element(selector), text }); },
    async click(selector) { await send("WebDriver:ElementClick", { id: await element(selector) }); },
    close() { socket.destroy(); },
  };
}
