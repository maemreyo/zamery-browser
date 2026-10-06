import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";
import { stageAcceptanceCompanion } from "../live/stage-companion.mjs";

const PRESENCE_JS = fs.readFileSync(new URL("../runtime/companion/agent-presence.js", import.meta.url), "utf8");
const CONTENT_JS = fs.readFileSync(new URL("../runtime/companion/content.js", import.meta.url), "utf8");

function loadPresence(html = '<button id="target">Target</button>', { reducedMotion = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://app.test/page",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const rafs = new Map();
  const timers = new Map();
  const animations = [];
  const shadowRoots = [];
  let nextRaf = 1;
  let nextTimer = 1;
  const originalAttachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function attachShadow(init) {
    const root = originalAttachShadow.call(this, init);
    shadowRoots.push(root);
    return root;
  };
  window.requestAnimationFrame = (callback) => {
    const id = nextRaf++;
    rafs.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => { rafs.delete(id); };
  window.setTimeout = (callback, ms) => {
    const id = nextTimer++;
    timers.set(id, { callback, ms });
    return id;
  };
  window.clearTimeout = (id) => { timers.delete(id); };
  window.matchMedia = () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} });
  window.Element.prototype.animate = function animate(keyframes, options) {
    const animation = { target: this, keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation;
  };
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.id === "target-2") return { left: 80, top: 90, width: 120, height: 40, right: 200, bottom: 130 };
    return { left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50 };
  };
  window.eval(PRESENCE_JS);
  const runtime = window.ZameryAgentPresenceV1.bindDocument("doc-1");
  runtime.syncScope({
    expected_document_id: "doc-1",
    enabled: true,
    scope_valid: true,
    control_revision: 1,
    presentation_epoch: "test-epoch",
    presentation_revision: 1,
  });
  return {
    window,
    document: window.document,
    runtime,
    rafs,
    timers,
    animations,
    shadow: () => shadowRoots.at(-1),
    runRaf(id) {
      const callback = rafs.get(id);
      rafs.delete(id);
      callback?.(0);
    },
  };
}

describe("Firefox agent presence presentation", () => {
  it("uses fixed labels, exact target geometry, and inert inaccessible presentation DOM", () => {
    const page = loadPresence();
    const target = page.document.querySelector("#target");
    page.runtime.showAction(target, "fill");
    const shadow = page.shadow();
    const wrapper = shadow.querySelector(".wrapper");
    const label = shadow.querySelector(".label");
    const host = page.document.querySelector('[data-zamery-agent-presence="v1"]');
    assert.equal(label.textContent, "AI · fill");
    assert.ok(!shadow.textContent.includes("secret-value"));
    assert.deepEqual([wrapper.style.left, wrapper.style.top, wrapper.style.width, wrapper.style.height], ["10px", "20px", "100px", "30px"]);
    assert.equal(host.getAttribute("aria-hidden"), "true");
    assert.equal(host.style.pointerEvents, "none");
    assert.equal(shadow.querySelectorAll("button,a,input,select,textarea,[tabindex]").length, 0);
    page.runtime.clear();
  });

  it("uses a static bounded cue under reduced motion and starts no WAAPI animation", () => {
    const page = loadPresence(undefined, { reducedMotion: true });
    page.runtime.showAction(page.document.querySelector("#target"), "click");
    assert.equal(page.animations.length, 0);
    assert.equal(page.shadow().querySelector(".ring").style.opacity, "1");
    assert.ok([...page.timers.values()].some((entry) => entry.ms === 650));
    page.runtime.clear();
  });

  it("prevents stale cleanup from removing a newer cue and clears a disconnected target", () => {
    const page = loadPresence('<button id="target">One</button><button id="target-2">Two</button>');
    page.runtime.showAction(page.document.querySelector("#target"), "fill");
    const oldTimer = [...page.timers.values()].find((entry) => entry.ms === 900).callback;
    page.runtime.showAction(page.document.querySelector("#target-2"), "click");
    oldTimer();
    assert.equal(page.shadow().querySelector(".label").textContent, "AI · click");
    assert.equal(page.shadow().querySelector(".wrapper").hidden, false);

    page.document.querySelector("#target-2").remove();
    const currentRaf = [...page.rafs.keys()].at(-1);
    page.runRaf(currentRaf);
    assert.equal(page.shadow().querySelector(".wrapper").hidden, true);
  });

  it("ignores stale scope sync and clear messages from an older presentation revision", () => {
    const page = loadPresence();
    const disabled = page.runtime.syncScope({
      expected_document_id: "doc-1",
      enabled: false,
      scope_valid: false,
      control_revision: 1,
      presentation_epoch: "test-epoch",
      presentation_revision: 3,
    });
    assert.equal(disabled.ok, true);

    const staleSync = page.runtime.syncScope({
      expected_document_id: "doc-1",
      enabled: true,
      scope_valid: true,
      control_revision: 1,
      presentation_epoch: "test-epoch",
      presentation_revision: 2,
    });
    assert.equal(staleSync.ok, false);
    assert.equal(staleSync.reason, "stale_presentation_revision");
    assert.equal(page.runtime.status().enabled, false);
    assert.equal(page.runtime.status().scope_valid, false);

    const enabled = page.runtime.syncScope({
      expected_document_id: "doc-1",
      enabled: true,
      scope_valid: true,
      control_revision: 1,
      presentation_epoch: "test-epoch",
      presentation_revision: 4,
    });
    assert.equal(enabled.ok, true);
    page.runtime.showAction(page.document.querySelector("#target"), "click");
    assert.equal(page.shadow().querySelector(".wrapper").hidden, false);

    const staleClear = page.runtime.clearPresentation({
      expected_document_id: "doc-1",
      control_revision: 1,
      presentation_epoch: "test-epoch",
      presentation_revision: 3,
    });
    assert.equal(staleClear.ok, false);
    assert.equal(staleClear.reason, "stale_presentation_revision");
    assert.equal(page.shadow().querySelector(".wrapper").hidden, false, "an old clear must not remove the newer cue");

    const wrongDocumentClear = page.runtime.clearPresentation({
      expected_document_id: "doc-old",
      control_revision: 1,
      presentation_epoch: "test-epoch",
      presentation_revision: 5,
    });
    assert.equal(wrongDocumentClear.ok, false);
    assert.equal(wrongDocumentClear.reason, "document_mismatch");
    assert.equal(page.runtime.status().presentation_revision, 4, "a clear for another document must not advance presentation state");
    assert.equal(page.shadow().querySelector(".wrapper").hidden, false, "a clear for another document must not remove the current cue");
    page.runtime.clear();
  });

  it("keeps independent suppression tokens, never resurrects an old cue, and recovers on hard expiry", async () => {
    const page = loadPresence();
    page.runtime.showAction(page.document.querySelector("#target"), "key");
    const first = page.runtime.suppress("cap-1", "doc-1", Date.now() + 30_000);
    const second = page.runtime.suppress("cap-2", "doc-1", Date.now() + 30_000);
    assert.equal(first.state, "suppression_applied");
    assert.equal(second.state, "suppression_applied");
    assert.equal(page.runtime.status().suppression_count, 2);

    assert.equal(page.runtime.release("cap-1", "doc-1").suppression_active, true);
    assert.equal(page.document.querySelector('[data-zamery-agent-presence="v1"]').style.visibility, "hidden");
    assert.equal(page.runtime.release("cap-2", "doc-1").suppression_active, false);
    assert.equal(page.shadow().querySelector(".wrapper").hidden, true, "release never replays the pre-capture cue");

    page.runtime.suppress("cap-expire", "doc-1", Date.now() + 30_000);
    const expiry = [...page.timers.values()].find((entry) => entry.ms > 29_000);
    expiry.callback();
    assert.equal(page.runtime.status().suppressed, false);
    assert.equal(page.document.querySelector('[data-zamery-agent-presence="v1"]').style.visibility, "");
  });

  it("confirms visible suppression only after two animation frames", async () => {
    const page = loadPresence();
    page.runtime.suppress("cap", "doc-1", Date.now() + 30_000);
    const pending = page.runtime.confirmSuppression("cap", "doc-1");
    const first = [...page.rafs.keys()].at(-1);
    page.runRaf(first);
    const second = [...page.rafs.keys()].at(-1);
    page.runRaf(second);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.paint_barrier, "foreground-double-raf");
    page.runtime.release("cap", "doc-1");
  });

  it("is idempotent when the helper is injected repeatedly", () => {
    const page = loadPresence();
    const original = page.window.ZameryAgentPresenceV1;
    page.window.eval(PRESENCE_JS);
    assert.equal(page.window.ZameryAgentPresenceV1, original);
  });
});

describe("agent presence loading contract", () => {
  it("loads before content in both manifests and reports an explicit capability/version handshake", async () => {
    for (const file of ["manifest.json", "manifest.development.json"]) {
      const manifest = JSON.parse(fs.readFileSync(new URL(`../runtime/companion/${file}`, import.meta.url), "utf8"));
      const scripts = manifest.content_scripts[0].js;
      assert.ok(scripts.indexOf("agent-presence.js") >= 0);
      assert.ok(scripts.indexOf("agent-presence.js") < scripts.indexOf("content.js"));
    }

    const dom = new JSDOM('<!doctype html><html><body><button>Go</button></body></html>', { url: "https://app.test/", runScripts: "outside-only", pretendToBeVisual: true });
    const listeners = [];
    dom.window.browser = { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, sendMessage: async () => undefined } };
    dom.window.requestAnimationFrame = () => 1;
    dom.window.cancelAnimationFrame = () => undefined;
    dom.window.matchMedia = () => ({ matches: false });
    dom.window.Element.prototype.animate = () => ({ cancel() {} });
    dom.window.Element.prototype.getClientRects = () => [{ width: 10, height: 10 }];
    dom.window.eval(PRESENCE_JS);
    dom.window.eval(CONTENT_JS);
    let ping;
    for (const listener of listeners) {
      const result = listener({ type: "zamery_browser_firefox_ping" });
      if (result !== undefined) { ping = await result; break; }
    }
    assert.equal(ping.agent_presence_v1_ready, true);
    assert.equal(ping.agent_presence_version, 1);
  });

  it("keeps fallback injection and isolated live staging aligned with manifest loading", () => {
    const background = fs.readFileSync(new URL("../runtime/companion/background.js", import.meta.url), "utf8");
    const helperInjections = [...background.matchAll(/file: "agent-presence\.js"/g)].length;
    const contentInjections = [...background.matchAll(/file: "content\.js"/g)].length;
    assert.ok(helperInjections >= contentInjections, `helper injections=${helperInjections}, content injections=${contentInjections}`);

    const staged = fs.mkdtempSync(path.join(os.tmpdir(), "zamery-presence-stage-"));
    try {
      const result = stageAcceptanceCompanion(staged);
      assert.equal(fs.existsSync(path.join(staged, "agent-presence.js")), true);
      const scripts = result.manifest.content_scripts[0].js;
      assert.ok(scripts.indexOf("agent-presence.js") < scripts.indexOf("content.js"));
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }
  });
});
