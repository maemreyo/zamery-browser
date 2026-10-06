import assert from "node:assert/strict";
import crypto from "node:crypto";
import vm from "node:vm";
import { describe, it } from "node:test";

import { loadCompanion, pageScript, settle } from "./helpers/companion-harness.mjs";
import { makePng, pngDataUrl, quadrantPng } from "./helpers/png.mjs";

const AUD = "audience-shots-aaaa";
const NODE = { node_id: "n1", role: "button", name: "Go", tag: "button" };
let sequence = 0;
const rid = (prefix = "s") => `${prefix}-${++sequence}`;

async function boot({ actions, png = quadrantPng(), viewport, snapshotNodes = [] } = {}) {
  const c = await loadCompanion({ tabs: [{ id: 1, url: "https://a.test/", title: "A", active: true }, { id: 2, url: "https://b.test/", active: false }] });
  const page = pageScript({ snapshotNodes });
  const baseHandler = page.handler;
  page.handler = async (message, tab) => {
    const reply = await baseHandler(message, tab);
    if (message.type === "zamery_browser_firefox_ping" && reply) return { ...reply, viewport_width: viewport?.width ?? 800, viewport_height: viewport?.height ?? 600, scroll_x: viewport?.x ?? 0, scroll_y: viewport?.y ?? 120, device_pixel_ratio: 2 };
    return reply;
  };
  c.state.contentHandlers.set(1, page.handler);
  c.state.captureResult = pngDataUrl(png);
  await c.hostStatus();
  await c.request({ id: rid(), op: "status", audience_id: AUD, params: {} });
  const granted = await c.popup({ type: "zamery_browser_firefox_grant", audience_id: AUD, tab_ids: [1], duration: { mode: "session" }, actions });
  assert.equal(granted.ok, true);
  const ask = (op, params = {}, audience = AUD) => c.request({ id: rid(op), op, audience_id: audience, params });
  const artifactsMap = () => vm.runInContext("artifacts", c.context);
  return { c, ask, page, png, artifactsMap };
}

async function download(ask, descriptor) {
  const parts = [];
  for (let seq = 0; ; seq += 1) {
    const response = await ask("artifact_read_chunk", { artifact_id: descriptor.artifact_id, sequence: seq, offset: parts.reduce((n, p) => n + p.length, 0) });
    assert.equal(response.ok, true, JSON.stringify(response));
    parts.push(Buffer.from(response.result.data_base64, "base64"));
    assert.ok(response.result.data_base64.length < 100_000, "chunk stays well below the 256 KiB envelope");
    if (response.result.eof) return { bytes: Buffer.concat(parts), terminal: response.result.terminal, chunks: parts.length };
  }
}

describe("bounded screenshot capture", () => {
  it("captures the observed viewport with an explicit scale and reports measured facts", async () => {
    const { c, ask, png } = await boot();
    const response = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(response.ok, true, JSON.stringify(response));
    const d = response.result;
    assert.deepEqual(c.state.captureCalls[0].opts, { format: "png", scale: 1, rect: { x: 0, y: 120, width: 800, height: 600 } });
    assert.equal(d.media_type, "image/png");
    assert.equal(d.width, 240);
    assert.equal(d.height, 160);
    assert.equal(d.byte_size, png.length);
    assert.equal(d.sha256, crypto.createHash("sha256").update(png).digest("hex"));
    assert.deepEqual(d.captured_rect, { x: 0, y: 120, width: 800, height: 600 });
    assert.ok(d.expires_at - d.created_at === 30 * 60 * 1000);
    assert.ok(!JSON.stringify(response).includes("base64"), "no pixels in the descriptor");
  });

  it("honours an explicit rect, scale, max_side and jpeg quality", async () => {
    const { c, ask } = await boot();
    const response = await ask("screenshot_capture", { context_id: "tab:1", rect: { x: 10, y: 20, width: 2000, height: 1000 }, max_side: 1000, format: "jpeg", quality: 70 });
    assert.equal(response.error.reason, "unexpected_capture_result", "the mock returned PNG for a JPEG request");
    assert.deepEqual(c.state.captureCalls[0].opts, { format: "jpeg", scale: 0.5, rect: { x: 10, y: 20, width: 2000, height: 1000 }, quality: 70 });
  });

  it("rejects out-of-bound or malformed requests before touching the browser", async () => {
    const { c, ask } = await boot();
    const bad = [
      [{ rect: { x: 0, y: 0, width: 5000, height: 10 } }, "rect_side_too_large"],
      [{ rect: { x: 0, y: 0, width: 10.5, height: 10 } }, "invalid_rect_size"],
      [{ rect: { x: 0, y: 0, width: 0, height: 10 } }, "invalid_rect_size"],
      [{ rect: { x: -1, y: 0, width: 10, height: 10 } }, "invalid_rect_origin"],
      [{ rect: { x: 0, y: 0, width: 10, height: 10 }, scale: 0 }, "invalid_scale"],
      [{ rect: { x: 0, y: 0, width: 10, height: 10 }, scale: 1.5 }, "invalid_scale"],
      [{ rect: { x: 0, y: 0, width: 10, height: 10 }, scale: -1 }, "invalid_scale"],
      [{ rect: { x: 0, y: 0, width: 10, height: 10 }, scale: "big" }, "invalid_scale"],
      [{ rect: { x: 0, y: 0, width: 4096, height: 4096 } }, "pixel_budget_exceeded"],
      [{ max_side: 99999 }, "invalid_max_side"],
      [{ format: "gif" }, "invalid_format"],
      [{ format: "jpeg", quality: 0 }, "invalid_quality"],
    ];
    for (const [extra, reason] of bad) {
      const response = await ask("screenshot_capture", { context_id: "tab:1", ...extra });
      assert.equal(response.ok, false, reason);
      assert.equal(response.error.reason, reason, JSON.stringify(response.error));
      assert.equal(response.outcome, "not_started");
    }
    assert.equal(c.state.captureCalls, undefined, "Firefox was never asked to capture");
  });

  it("requires the capture action and an authorized tab", async () => {
    const noCapture = await boot({ actions: ["inspect", "interact"] });
    assert.equal((await noCapture.ask("screenshot_capture", { context_id: "tab:1" })).error.reason, "action_outside_scope");
    const { ask, c } = await boot();
    assert.equal((await ask("screenshot_capture", { context_id: "tab:2" })).error.reason, "outside_scope");
    assert.equal(c.state.captureCalls, undefined);
  });

  it("allows one capture at a time", async () => {
    const { c, ask } = await boot();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = c.browser.tabs.captureTab;
    c.browser.tabs.captureTab = async (...args) => { await gate; return original(...args); };
    const first = ask("screenshot_capture", { context_id: "tab:1" });
    await settle(40);
    const second = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(second.error.code, "RESOURCE_BUSY");
    release();
    assert.equal((await first).ok, true);
    assert.equal((await ask("screenshot_capture", { context_id: "tab:1" })).ok, true, "the slot is released afterwards");
  });

  it("does not dispatch capture if authority is revoked while suppression confirmation is pending", async () => {
    const { c, ask } = await boot();
    const originalHandler = c.state.contentHandlers.get(1);
    let releaseConfirm;
    const confirmGate = new Promise((resolve) => { releaseConfirm = resolve; });
    c.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_overlay_confirm_suppression") await confirmGate;
      return originalHandler(message, tab);
    });
    const pending = ask("screenshot_capture", { context_id: "tab:1" });
    await settle(40);
    await c.popup({ type: "zamery_browser_firefox_revoke" });
    releaseConfirm();
    const response = await pending;
    assert.equal(response.ok, false);
    assert.ok(["authorization_changed_before_capture", "authorization_changed_during_request"].includes(response.error.reason), JSON.stringify(response.error));
    assert.equal(c.state.captureCalls, undefined, "captureTab must not run after revoke during the barrier");
  });

  it("does not dispatch capture if capture scope is removed while suppression confirmation is pending", async () => {
    const { c, ask } = await boot({ actions: ["inspect", "interact", "capture"] });
    const originalHandler = c.state.contentHandlers.get(1);
    let releaseConfirm;
    const confirmGate = new Promise((resolve) => { releaseConfirm = resolve; });
    c.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_overlay_confirm_suppression") await confirmGate;
      return originalHandler(message, tab);
    });
    const pending = ask("screenshot_capture", { context_id: "tab:1" });
    await settle(40);
    const reduced = await c.popup({
      type: "zamery_browser_firefox_manage_access",
      tab_ids: [1],
      actions: ["inspect", "interact"],
      control_mode: "interactive",
    });
    assert.equal(reduced.ok, true);
    releaseConfirm();
    const response = await pending;
    assert.equal(response.ok, false);
    assert.equal(c.state.captureCalls, undefined, "captureTab must not run after capture scope shrinks during the barrier");
  });

  it("does not dispatch capture if the document changes immediately after suppression confirmation", async () => {
    const { c, ask, page } = await boot();
    const originalHandler = c.state.contentHandlers.get(1);
    c.state.contentHandlers.set(1, async (message, tab) => {
      const response = await originalHandler(message, tab);
      if (message.type === "zamery_browser_firefox_overlay_confirm_suppression" && response?.ok) page.documentId = "doc-2";
      return response;
    });
    const response = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(response.ok, false);
    assert.equal(response.error.reason, "document_changed_before_capture");
    assert.equal(c.state.captureCalls, undefined, "captureTab must not run after document replacement during the barrier");
  });

  it("does not dispatch capture if authority is revoked during the final presence sync", async () => {
    const { c, ask } = await boot();
    const originalHandler = c.state.contentHandlers.get(1);
    let syncCount = 0;
    let revoked = false;
    c.state.contentHandlers.set(1, async (message, tab) => {
      const response = await originalHandler(message, tab);
      if (message.type === "zamery_browser_firefox_presence_sync") {
        syncCount += 1;
        if (syncCount === 2 && !revoked) {
          revoked = true;
          await c.popup({ type: "zamery_browser_firefox_revoke" });
        }
      }
      return response;
    });
    const response = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(response.ok, false);
    assert.ok(
      ["authorization_changed_before_capture", "authorization_changed_during_request"].includes(response.error.reason),
      JSON.stringify(response.error),
    );
    assert.equal(c.state.captureCalls, undefined, "captureTab must not run after revoke during the final presentation sync");
  });

  it("does not dispatch capture if the origin changes during the final presence sync", async () => {
    const { c, ask } = await boot();
    const originalHandler = c.state.contentHandlers.get(1);
    let syncCount = 0;
    let changedOrigin = false;
    c.state.contentHandlers.set(1, async (message, tab) => {
      const response = await originalHandler(message, tab);
      if (message.type === "zamery_browser_firefox_presence_sync") {
        syncCount += 1;
        if (syncCount === 2 && !changedOrigin) {
          changedOrigin = true;
          await c.browser.tabs.update(1, { url: "https://evil.test/" });
        }
      }
      return response;
    });
    const response = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(response.ok, false);
    assert.equal(response.error.reason, "origin_changed_confirmation_required", JSON.stringify(response.error));
    assert.equal(c.state.captureCalls, undefined, "captureTab must not run after an origin change during the final presentation sync");
  });

  it("does not add a claim requirement when Take over happens during suppression confirmation", async () => {
    const { c, ask } = await boot();
    const originalHandler = c.state.contentHandlers.get(1);
    let tookOver = false;
    c.state.contentHandlers.set(1, async (message, tab) => {
      const response = await originalHandler(message, tab);
      if (message.type === "zamery_browser_firefox_overlay_confirm_suppression" && response?.ok && !tookOver) {
        tookOver = true;
        await c.popup({ type: "zamery_browser_firefox_takeover" });
      }
      return response;
    });
    const response = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(c.state.captureCalls.length, 1);
  });

  it("keeps suppression through Take over, Resume and a new action until the underlying capture settles", async () => {
    const { c, ask, page } = await boot({ actions: ["inspect", "interact", "capture"], snapshotNodes: [NODE] });
    let releaseCapture;
    const originalCapture = c.browser.tabs.captureTab;
    c.browser.tabs.captureTab = async (...args) => {
      await new Promise((resolve) => { releaseCapture = resolve; });
      return originalCapture(...args);
    };

    const pendingCapture = ask("screenshot_capture", { context_id: "tab:1" });
    for (let index = 0; index < 20 && !releaseCapture; index += 1) await settle(10);
    assert.equal(page.suppressionTokens.size, 1);

    await c.popup({ type: "zamery_browser_firefox_takeover" });
    assert.equal(page.suppressionTokens.size, 1, "takeover must not release capture suppression");
    await c.popup({ type: "zamery_browser_firefox_resume" });
    assert.equal(page.suppressionTokens.size, 1, "resume must not release capture suppression");

    const snapshot = await ask("snapshot", { context_id: "tab:1", claim: true });
    const ref = snapshot.result.nodes[0]?.ref;
    assert.ok(ref, "fixture must expose an actionable target");
    const actsBefore = page.acts.length;
    const acted = await ask("act", { context_id: "tab:1", ref, action: "click" });
    assert.equal(acted.ok, true, JSON.stringify(acted));
    assert.equal(page.acts.length, actsBefore + 1, "the new action must actually dispatch while capture is pending");
    assert.equal(page.acts.at(-1).action, "click");
    assert.equal(page.suppressionTokens.size, 1, "a new action generation must remain suppressed during capture");

    releaseCapture();
    assert.equal((await pendingCapture).ok, true);
    assert.equal(page.suppressionTokens.size, 0);
  });

  it("fails cleanly when the suppress ACK is lost and converges suppression by idempotent release", async () => {
    const { c, ask, page } = await boot();
    const originalHandler = c.state.contentHandlers.get(1);
    c.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 1_000 ? 30 : ms);
    c.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_overlay_suppress") {
        await originalHandler(message, tab); // suppression applied, response is lost
        return new Promise(() => {});
      }
      return originalHandler(message, tab);
    });
    const response = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(response.ok, false);
    assert.equal(response.error.reason, "overlay_suppression_timeout");
    assert.equal(c.state.captureCalls, undefined);
    await settle(80);
    assert.equal(page.suppressionTokens.size, 0, "release recovery removes a token whose suppress ACK was lost");
  });

  it("retries lost release acknowledgements without extending suppression forever", async () => {
    const { c, ask, page } = await boot();
    const originalHandler = c.state.contentHandlers.get(1);
    let releases = 0;
    c.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 1_000 ? 30 : ms);
    c.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_overlay_release") {
        releases += 1;
        const response = await originalHandler(message, tab);
        if (releases < 3) return new Promise(() => {}); // state changed but ACK was lost twice
        return response;
      }
      return originalHandler(message, tab);
    });
    const response = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(releases, 3, "one initial release plus two bounded retries");
    assert.equal(page.suppressionTokens.size, 0);
  });

  it("drops the capture when authority ends while Firefox is rendering", async () => {
    const { c, ask, artifactsMap } = await boot();
    const original = c.browser.tabs.captureTab;
    c.browser.tabs.captureTab = async (...args) => { await c.popup({ type: "zamery_browser_firefox_revoke" }); return original(...args); };
    const response = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(response.ok, false);
    assert.equal(response.result, undefined);
    assert.equal(artifactsMap().size, 0);
  });

  it("rejects pixels whose page changed during capture", async () => {
    const { c, ask, page, artifactsMap } = await boot();
    const original = c.browser.tabs.captureTab;
    c.browser.tabs.captureTab = async (...args) => { page.documentId = "doc-2"; return original(...args); };
    const response = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(response.error.reason, "document_changed_during_capture");
    assert.equal(artifactsMap().size, 0);
  });

  it("enforces encoded and decoded limits and rejects non-image results", async () => {
    const huge = await boot();
    huge.c.state.captureResult = `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`;
    assert.equal((await huge.ask("screenshot_capture", { context_id: "tab:1" })).error.reason, "encoded_image_too_large");

    const wide = await boot({ png: makePng(5000, 4, () => [1, 2, 3]) });
    assert.equal((await wide.ask("screenshot_capture", { context_id: "tab:1" })).error.reason, "decoded_dimensions_exceed_limit");

    const notImage = await boot();
    notImage.c.state.captureResult = "data:text/html;base64,PGh0bWw+";
    assert.equal((await notImage.ask("screenshot_capture", { context_id: "tab:1" })).error.reason, "unexpected_capture_result");

    const garbage = await boot();
    garbage.c.state.captureResult = "data:image/png;base64,AAAA";
    assert.equal((await garbage.ask("screenshot_capture", { context_id: "tab:1" })).error.reason, "image_header_unreadable");
  });

  it("times out a caller, keeps suppression until the underlying capture settles, and never publishes late pixels", async () => {
    const { c, ask, artifactsMap } = await boot();
    let resolveCapture;
    c.browser.tabs.captureTab = () => new Promise((resolve) => { resolveCapture = resolve; });
    // Shorten only the 20s caller deadline; keep the hard-expiry distinct so we can prove the slot stays held.
    c.context.setTimeout = (fn, ms) => setTimeout(fn, ms === 20_000 ? 30 : ms === 30_000 ? 500 : ms);
    const response = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(response.error.reason, "capture_timeout");
    assert.equal(artifactsMap().size, 0);

    const whilePending = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.equal(whilePending.error.code, "RESOURCE_BUSY", "underlying capture still owns the slot after caller timeout");

    resolveCapture(pngDataUrl(quadrantPng()));
    await settle(40);
    assert.equal(artifactsMap().size, 0, "late pixels are permanently disqualified from artifact publication");
    c.browser.tabs.captureTab = async () => pngDataUrl(quadrantPng());
    assert.equal((await ask("screenshot_capture", { context_id: "tab:1" })).ok, true);
  });
});

describe("artifact transport and lifetime", () => {
  it("streams in <= 64 KiB chunks with a terminal digest, replaying the current chunk identically", async () => {
    const big = makePng(400, 300, (x, y) => [(x * 7 + y * 13) & 255, (x * 3) & 255, (y * 5) & 255]);
    const { ask } = await boot({ png: big });
    const captured = await ask("screenshot_capture", { context_id: "tab:1" });
    assert.ok(captured.result.byte_size > 64 * 1024, `fixture is ${captured.result.byte_size} bytes`);
    const first = await ask("artifact_read_chunk", { artifact_id: captured.result.artifact_id, sequence: 0, offset: 0 });
    const replay = await ask("artifact_read_chunk", { artifact_id: captured.result.artifact_id, sequence: 0, offset: 0 });
    assert.deepEqual(replay.result, first.result);
    assert.equal(first.result.raw_bytes, 64 * 1024);
    const all = await download(ask, captured.result);
    assert.ok(all.chunks > 1);
    assert.deepEqual(all.bytes, big);
    assert.equal(all.terminal.sha256, captured.result.sha256);
    assert.equal(all.terminal.bytes, big.length);
    assert.equal((await ask("artifact_read_chunk", { artifact_id: captured.result.artifact_id, sequence: 1, offset: 5 })).error.reason, "chunk_sequence_offset_mismatch");
    assert.equal((await ask("artifact_read_chunk", { artifact_id: captured.result.artifact_id, sequence: 0, offset: big.length + 1 })).error.reason, "invalid_chunk_position");
  });

  it("denies reads to other audiences, after revoke, and for expired artifacts", async () => {
    const { c, ask, artifactsMap } = await boot();
    const captured = (await ask("screenshot_capture", { context_id: "tab:1" })).result;
    const read = (audience = AUD) => ask("artifact_read_chunk", { artifact_id: captured.artifact_id, sequence: 0, offset: 0 }, audience);
    assert.equal((await read("audience-intruder-zzzz")).error.reason, "audience_mismatch");
    assert.equal((await read()).ok, true);

    artifactsMap().get(captured.artifact_id).expiresAt = Date.now() - 1;
    const expired = await read();
    assert.equal(expired.error.code, "ARTIFACT_EXPIRED");
    assert.equal(artifactsMap().size, 0);

    const again = (await ask("screenshot_capture", { context_id: "tab:1" })).result;
    await c.popup({ type: "zamery_browser_firefox_revoke" });
    assert.equal(artifactsMap().size, 0, "revoke drops every artifact immediately");
    const afterRevoke = await ask("artifact_read_chunk", { artifact_id: again.artifact_id, sequence: 0, offset: 0 });
    assert.equal(afterRevoke.error.code, "BROWSER_AUTHORIZATION_REQUIRED");
    await c.popup({ type: "zamery_browser_firefox_grant", audience_id: AUD, tab_ids: [1] });
    assert.equal((await ask("artifact_read_chunk", { artifact_id: again.artifact_id, sequence: 0, offset: 0 })).error.code, "ARTIFACT_EXPIRED", "a new grant does not resurrect old pixels");
  });

  it("stops serving an artifact when its tab leaves scope or changes site", async () => {
    const { c, ask } = await boot();
    const captured = (await ask("screenshot_capture", { context_id: "tab:1" })).result;
    c.tabs.get(1).url = "https://evil.test/";
    await c.events.tabsOnUpdated.fire(1, { url: "https://evil.test/" }, c.tabs.get(1));
    const response = await ask("artifact_read_chunk", { artifact_id: captured.artifact_id, sequence: 0, offset: 0 });
    assert.equal(response.ok, false);
    assert.equal(response.error.reason, "origin_changed_confirmation_required");
  });

  it("caps stored artifacts per audience by evicting the oldest", async () => {
    const { ask, artifactsMap } = await boot();
    const ids = [];
    for (let index = 0; index < 18; index += 1) ids.push((await ask("screenshot_capture", { context_id: "tab:1" })).result.artifact_id);
    assert.ok(artifactsMap().size <= 16);
    assert.ok(!artifactsMap().has(ids[0]), "oldest evicted");
    assert.ok(artifactsMap().has(ids[17]));
  });

  it("close frees an artifact", async () => {
    const { ask, artifactsMap } = await boot();
    const captured = (await ask("screenshot_capture", { context_id: "tab:1" })).result;
    await ask("artifact_close", { artifact_id: captured.artifact_id });
    assert.equal(artifactsMap().size, 0);
  });
});
