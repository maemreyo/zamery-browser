import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";

const CONTENT_JS = fs.readFileSync(new URL("../runtime/companion/content.js", import.meta.url), "utf8");

/** Loads the real content.js into a jsdom window with a minimal `browser` stub. */
function loadPage(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://app.test/form",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // jsdom has no layout engine: treat everything as laid out unless explicitly marked.
  window.Element.prototype.getClientRects = function getClientRects() {
    return this.hasAttribute("data-no-layout") ? [] : [{ width: 10, height: 10 }];
  };
  const listeners = [];
  const sent = [];
  window.browser = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (message) => { sent.push(message); },
    },
  };
  if (!window.crypto?.randomUUID) window.crypto = { randomUUID: () => `doc-${Math.random().toString(36).slice(2)}` };
  window.eval(CONTENT_JS);
  const call = async (message) => {
    for (const listener of listeners) {
      const result = listener(message);
      if (result !== undefined) return result;
    }
    return undefined;
  };
  return { window, document: window.document, call, sent };
}

const CANARIES = ["TEXT-VALUE-CANARY-41", "HIDDEN-VALUE-CANARY-52", "PASSWORD-CANARY-63", "TEXTAREA-CANARY-74", "EDITABLE-CANARY-85", "SELECT-CANARY-96", "OTP-CANARY-107", "SEARCH-CANARY-118"];

const FORM = `
  <label for="email">Email</label>
  <input id="email" type="text" value="${CANARIES[0]}">
  <input type="hidden" name="csrf" value="${CANARIES[1]}">
  <label for="pw">Password</label>
  <input id="pw" type="password" value="${CANARIES[2]}">
  <label for="notes">Notes</label>
  <textarea id="notes">${CANARIES[3]}</textarea>
  <div id="rich" contenteditable="true" aria-label="Message">${CANARIES[4]}</div>
  <label for="plan">Plan</label>
  <select id="plan"><option>${CANARIES[5]}</option></select>
  <input id="code" type="text" autocomplete="one-time-code" placeholder="Code" value="${CANARIES[6]}">
  <input id="q" type="search" placeholder="Search" value="${CANARIES[7]}">
  <input type="text" aria-hidden="true" value="ARIA-HIDDEN-CANARY">
  <input type="text" style="display:none" value="DISPLAY-NONE-CANARY">
  <input type="text" data-no-layout value="NO-LAYOUT-CANARY">
  <button id="go">Save changes</button>
  <input type="submit" value="Send it">
`;

describe("snapshot privacy (F03)", () => {
  it("exports no form values and no non-rendered controls", async () => {
    const page = loadPage(FORM);
    const snapshot = await page.call({ type: "zamery_browser_firefox_snapshot" });
    const serialized = JSON.stringify(snapshot);
    for (const canary of [...CANARIES, "ARIA-HIDDEN-CANARY", "DISPLAY-NONE-CANARY", "NO-LAYOUT-CANARY"]) {
      assert.ok(!serialized.includes(canary), `${canary} leaked into the snapshot`);
    }
    assert.ok(snapshot.nodes.every((node) => !("value" in node)), "no node carries a value field");
    assert.equal(snapshot.coverage.values_exported, false);
    assert.equal(snapshot.coverage.hidden_controls_excluded, true);
  });

  it("still names controls usefully from labels, placeholders and button text", async () => {
    const page = loadPage(FORM);
    const snapshot = await page.call({ type: "zamery_browser_firefox_snapshot" });
    const names = snapshot.nodes.map((node) => node.name);
    for (const expected of ["Email", "Password", "Notes", "Message", "Plan", "Code", "Search", "Save changes", "Send it"]) {
      assert.ok(names.includes(expected), `missing name ${expected}; got ${JSON.stringify(names)}`);
    }
  });

  it("flags credential and one-time-code fields so the agent hands over", async () => {
    const page = loadPage(FORM);
    const snapshot = await page.call({ type: "zamery_browser_firefox_snapshot" });
    const flagged = snapshot.nodes.filter((node) => node.credential).map((node) => node.name).sort();
    assert.deepEqual([...flagged], ["Code", "Password"]);
  });

  it("detects credential hints by name/placeholder as well as type", async () => {
    const page = loadPage(`
      <input id="a" type="text" name="otp_code" aria-label="Enter code">
      <input id="b" type="text" placeholder="Security code">
      <input id="c" type="text" aria-label="Pinterest board">
    `);
    const snapshot = await page.call({ type: "zamery_browser_firefox_snapshot" });
    const byName = Object.fromEntries(snapshot.nodes.map((node) => [node.name, Boolean(node.credential)]));
    assert.equal(byName["Enter code"], true);
    assert.equal(byName["Security code"], true);
    assert.equal(byName["Pinterest board"], false);
  });

  it("reports truncation instead of silently dropping controls", async () => {
    const page = loadPage(Array.from({ length: 260 }, (_, index) => `<button>b${index}</button>`).join(""));
    const snapshot = await page.call({ type: "zamery_browser_firefox_snapshot" });
    assert.equal(snapshot.nodes.length, 250);
    assert.equal(snapshot.coverage.truncated, true);
  });

  it("does not report truncation when everything fits", async () => {
    const page = loadPage("<button>one</button>");
    assert.equal((await page.call({ type: "zamery_browser_firefox_snapshot" })).coverage.truncated, false);
  });
});

describe("act safety", () => {
  it("refuses to fill, type or key into credential fields and leaves them untouched", async () => {
    const page = loadPage(FORM);
    const snapshot = await page.call({ type: "zamery_browser_firefox_snapshot" });
    const password = snapshot.nodes.find((node) => node.name === "Password");
    const code = snapshot.nodes.find((node) => node.name === "Code");
    for (const [node, field] of [[password, "#pw"], [code, "#code"]]) {
      for (const [action, payload] of [["fill", { value: "agent-typed" }], ["type", { text: "agent-typed" }], ["key", { key: "a" }]]) {
        const result = await page.call({ type: "zamery_browser_firefox_act", document_id: snapshot.document_id, node_id: node.node_id, action, ...payload });
        assert.equal(result.error.code, "USER_TAKEOVER_REQUIRED", `${field} ${action}`);
        assert.equal(result.error.reason, "credential_field");
      }
    }
    assert.equal(page.document.querySelector("#pw").value, CANARIES[2]);
    assert.equal(page.document.querySelector("#code").value, CANARIES[6]);
  });

  it("fills ordinary fields, clicks buttons, and never counts its own synthetic events as human interaction", async () => {
    const page = loadPage(FORM);
    const snapshot = await page.call({ type: "zamery_browser_firefox_snapshot" });
    const email = snapshot.nodes.find((node) => node.name === "Email");
    const go = snapshot.nodes.find((node) => node.name === "Save changes");
    let clicks = 0;
    page.document.querySelector("#go").addEventListener("click", () => { clicks += 1; });
    const before = (await page.call({ type: "zamery_browser_firefox_ping" })).interaction_generation;
    const fill = await page.call({ type: "zamery_browser_firefox_act", document_id: snapshot.document_id, node_id: email.node_id, action: "fill", value: "agent@example.test" });
    const click = await page.call({ type: "zamery_browser_firefox_act", document_id: snapshot.document_id, node_id: go.node_id, action: "click" });
    assert.equal(fill.ok, true);
    assert.equal(click.ok, true);
    assert.equal(clicks, 1);
    assert.equal(page.document.querySelector("#email").value, "agent@example.test");
    assert.equal((await page.call({ type: "zamery_browser_firefox_ping" })).interaction_generation, before);
    assert.equal(fill.observed_is_trusted, false);
  });

  it("rejects an act for a node of a previous document", async () => {
    const page = loadPage(FORM);
    const snapshot = await page.call({ type: "zamery_browser_firefox_snapshot" });
    const result = await page.call({ type: "zamery_browser_firefox_act", document_id: "other-document", node_id: snapshot.nodes[0].node_id, action: "click" });
    assert.equal(result.error.code, "STALE_ELEMENT_REF");
  });
});

describe("human interaction tracking", () => {
  it("counts only trusted gestures and reports once when armed", async () => {
    const page = loadPage("<button id='b'>b</button>");
    // jsdom events are untrusted: nothing may count.
    page.document.querySelector("#b").dispatchEvent(new page.window.Event("pointerdown", { bubbles: true }));
    assert.equal((await page.call({ type: "zamery_browser_firefox_ping" })).interaction_generation, 0);

    // Simulate the browser delivering a trusted event by shadowing isTrusted on the instance.
    const trusted = (type) => {
      const event = new page.window.Event(type, { bubbles: true });
      try { Object.defineProperty(event, "isTrusted", { value: true }); } catch { return null; }
      return event;
    };
    const probe = trusted("pointerdown");
    if (!probe || probe.isTrusted !== true) return; // jsdom builds with an unforgeable isTrusted; covered in live Firefox acceptance
    await page.call({ type: "zamery_browser_firefox_arm" });
    page.document.querySelector("#b").dispatchEvent(probe);
    page.document.querySelector("#b").dispatchEvent(trusted("keydown"));
    assert.equal((await page.call({ type: "zamery_browser_firefox_ping" })).interaction_generation, 2);
    assert.equal(page.sent.filter((m) => m.type === "zamery_browser_firefox_interaction").length, 1);
  });

  it("is silent when not armed", async () => {
    const page = loadPage("<button id='b'>b</button>");
    page.document.querySelector("#b").dispatchEvent(new page.window.Event("keydown", { bubbles: true }));
    assert.equal(page.sent.length, 0);
  });
});

describe("readable page text (bounded)", () => {
  it("includes visible reading text but never form content or hidden text", async () => {
    const page = loadPage(`
      <h1>Quarterly report</h1>
      <p>Revenue grew <b>12%</b> year over year.</p>
      <ul><li><p>Nested paragraph once</p></li></ul>
      <p style="display:none">HIDDEN-TEXT-CANARY</p>
      <p aria-hidden="true">ARIA-HIDDEN-TEXT-CANARY</p>
      <textarea>TEXTAREA-BODY-CANARY</textarea>
      <div contenteditable="true"><p>EDITABLE-BODY-CANARY</p></div>
      <script>SCRIPT-CANARY</script>
    `);
    const snapshot = await page.call({ type: "zamery_browser_firefox_snapshot" });
    const texts = snapshot.text_blocks.map((block) => `${block.tag}:${block.text}`);
    assert.deepEqual([...texts], ["h1:Quarterly report", "p:Revenue grew 12% year over year.", "p:Nested paragraph once"]);
    const serialized = JSON.stringify(snapshot);
    for (const canary of ["HIDDEN-TEXT-CANARY", "TEXTAREA-BODY-CANARY", "EDITABLE-BODY-CANARY", "SCRIPT-CANARY"]) assert.ok(!serialized.includes(canary), canary);
    assert.equal(snapshot.coverage.text_truncated, false);
    assert.equal(snapshot.coverage.top_frame_only, true);
  });

  it("bounds the amount of text and says so", async () => {
    const page = loadPage(Array.from({ length: 400 }, (_, index) => `<p>${"word ".repeat(30)}${index}</p>`).join(""));
    const snapshot = await page.call({ type: "zamery_browser_firefox_snapshot" });
    assert.ok(snapshot.text_blocks.length <= 120);
    assert.ok(snapshot.text_blocks.reduce((sum, block) => sum + block.text.length, 0) <= 6000);
    assert.equal(snapshot.coverage.text_truncated, true);
    assert.ok(snapshot.text_blocks.every((block) => block.text.length <= 300));
  });
});
