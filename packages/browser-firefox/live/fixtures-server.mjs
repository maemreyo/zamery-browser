import http from "node:http";
import { quadrantPng } from "../test/helpers/png.mjs";

const page = (title, body, extraHead = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${extraHead}
<style>body{font:16px system-ui;margin:24px}input,button,textarea{font:inherit;margin:4px 0;padding:6px}.q{display:grid;grid-template-columns:200px 200px;grid-template-rows:120px 120px;width:400px}</style></head><body>${body}</body></html>`;

const ROUTES = {
  "/": () => page("Fixture home", "<h1>Fixture home</h1><p>Shared page body text for the agent.</p><a href='/form'>Form</a>"),
  "/form": () => page("Form fixture", `<h1>Profile form</h1>
    <label for="name">Full name</label><input id="name" name="name" value="PREFILLED-NAME-CANARY">
    <label for="note">Notes</label><textarea id="note">PREFILLED-NOTE-CANARY</textarea>
    <input type="hidden" name="csrf" value="HIDDEN-CSRF-CANARY">
    <button id="save" onclick="document.getElementById('out').textContent='saved:'+document.getElementById('name').value">Save</button>
    <div id="out" role="status"></div>`),
  "/login": () => page("Sign in", `<h1>Sign in</h1>
    <label for="user">Username</label><input id="user" name="user" autocomplete="username">
    <label for="pw">Password</label><input id="pw" type="password" name="pw" value="PREFILLED-PASSWORD-CANARY" autocomplete="current-password">
    <label for="code">Verification code</label><input id="code" name="otp" autocomplete="one-time-code">
    <button id="signin">Sign in</button>`),
  "/spa": () => page("SPA fixture", `<h1 id="title">Home view</h1><button id="next" onclick="history.pushState({}, '', '/spa#/next'); document.getElementById('title').textContent='Next view'">Go next</button>`),
  "/colors": () => page("Colors", `<h1>Color fixture</h1><div class="q"><div style="background:#dc1e1e"></div><div style="background:#1e3cdc"></div><div style="background:#1eaa3c"></div><div style="background:#f0dc1e"></div></div>`),
  "/article": () => page("Article", `<h1>Quarterly report</h1>${Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i + 1}: revenue grew steadily through the period.</p>`).join("")}`),
};

export function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    if (url.pathname === "/quadrants.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(quadrantPng(400, 240));
      return;
    }
    const route = ROUTES[url.pathname];
    if (!route) { response.writeHead(404); response.end("not found"); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(route());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    port: server.address().port,
    close: () => new Promise((done) => server.close(() => done())),
  })));
}
