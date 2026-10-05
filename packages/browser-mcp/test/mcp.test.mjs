import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import fs from "node:fs";

import { connect, connectStack, textOf } from "./helpers.mjs";
import { pngDataUrl, quadrantPng } from "../../browser-firefox/test/helpers/png.mjs";

const JPEG = fs.readFileSync(new URL("../../browser-firefox/test/fixtures/quadrants.jpg", import.meta.url));

const open = [];
afterEach(async () => { while (open.length) await open.pop().close(); });
const track = (value) => { open.push(value); return value; };

describe("discovery works before Firefox or any grant exists", () => {
  it("lists every implemented tool, with honest hints, and no code-execution escape", async () => {
    const emptyProvider = {
      protocolVersion: 2,
      listInstances: async () => [],
      status: async () => { throw new Error("no browser"); },
      close: async () => {},
    };
    const mcp = track(await connect({ provider: emptyProvider }));
    const { tools } = await mcp.client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["browser_artifact_read", "browser_click", "browser_contexts", "browser_fill", "browser_group", "browser_groups", "browser_handoff", "browser_key", "browser_mutation_status", "browser_screenshot", "browser_snapshot", "browser_status", "browser_tab", "browser_type"]);
    for (const required of ["browser_status", "browser_contexts", "browser_snapshot", "browser_click", "browser_fill", "browser_type", "browser_key", "browser_handoff", "browser_mutation_status"]) {
      assert.ok(names.includes(required), required);
    }
    assert.ok(!names.some((name) => /eval|script|execute|js|cdp|javascript/i.test(name)), "no raw JS/eval tool");
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.browser_status.annotations.readOnlyHint, true);
    assert.equal(byName.browser_contexts.annotations.readOnlyHint, true);
    assert.equal(byName.browser_click.annotations.destructiveHint, true, "a DOM click is not harmless");
    assert.equal(byName.browser_snapshot.annotations.readOnlyHint, false, "snapshot takes the write claim");
    // No tool lets the model pick a provider module, a filesystem path or self-grant access.
    const schemaText = JSON.stringify(tools.map((tool) => tool.inputSchema));
    assert.ok(!/provider_module|module_path|"path"|grant|duration/i.test(schemaText), schemaText.match(/provider_module|module_path|"path"|grant|duration/i)?.[0]);
  });

  it("browser_status explains how to proceed when Firefox is not connected", async () => {
    const mcp = track(await connect({ provider: { protocolVersion: 2, listInstances: async () => [], close: async () => {} } }));
    const result = await mcp.call("browser_status");
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.connected, false);
    assert.match(textOf(result), /Firefox is not connected/);
    assert.ok(result.structuredContent.guidance.length > 0);
  });

  it("refuses to guess between several connected profiles", async () => {
    const instances = [{ browserInstanceId: "b1", providerSessionId: "s1", ownership: {} }, { browserInstanceId: "b2", providerSessionId: "s2", ownership: {} }];
    const mcp = track(await connect({ provider: { protocolVersion: 2, listInstances: async () => instances, close: async () => {} } }));
    const status = await mcp.call("browser_status");
    assert.equal(status.structuredContent.state, "ambiguous");
    const snapshot = await mcp.call("browser_snapshot", { context_id: "tab:1" });
    assert.equal(snapshot.isError, true);
    assert.equal(snapshot.structuredContent.error.code, "BROWSER_INSTANCE_AMBIGUOUS");
  });
});

describe("single authorized tab vertical slice (full stack)", () => {
  it("reports not-granted guidance, then shares exactly one tab and never reveals the other", async () => {
    const stack = track(await connectStack());
    const before = await stack.call("browser_status");
    assert.equal(before.structuredContent.authorization.state, "revoked");
    assert.match(textOf(before), /Zamery Browser panel/);
    assert.equal((await stack.call("browser_contexts")).structuredContent.contexts.length, 0);

    await stack.grant();
    const status = await stack.call("browser_status");
    assert.equal(status.structuredContent.authorization.state, "granted");
    assert.equal(status.structuredContent.readiness.interact, true);

    const contexts = await stack.call("browser_contexts");
    assert.deepEqual(contexts.structuredContent.contexts.map((c) => c.context_id), ["tab:1"]);
    assert.ok(!textOf(contexts).includes("Private page"));

    const denied = await stack.call("browser_snapshot", { context_id: "tab:2" });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.error.reason, "outside_scope");
    assert.match(textOf(denied), /not shared with you/);
  });

  it("snapshots with a claim, acts with short refs, and verifies freshness", async () => {
    const stack = track(await connectStack());
    await stack.grant();
    const snap = await stack.call("browser_snapshot", { context_id: "tab:1" });
    assert.equal(snap.isError, undefined, textOf(snap));
    assert.equal(snap.structuredContent.claim.claimed, true);
    assert.match(textOf(snap), /untrusted data/);
    assert.match(textOf(snap), /Form values are not shown/);
    const node = snap.structuredContent.nodes[0];
    assert.equal(node.ref, "e1");

    const click = await stack.call("browser_click", { context_id: "tab:1", observation_id: snap.structuredContent.observation_id, ref: "e1" });
    assert.equal(click.isError, undefined, textOf(click));
    assert.equal(click.structuredContent.outcome, "completed");
    assert.match(textOf(click), /isTrusted=false/);
    assert.equal(stack.stack.pages[1].acts.length, 1);

    // Same request id replays from the host journal without a second dispatch.
    const requestId = click.structuredContent.request_id;
    const again = await stack.call("browser_click", { context_id: "tab:1", observation_id: snap.structuredContent.observation_id, ref: "e1", request_id: requestId });
    assert.equal(again.structuredContent.replayed, true);
    assert.equal(stack.stack.pages[1].acts.length, 1);

    const status = await stack.call("browser_mutation_status", { request_id: requestId });
    assert.equal(status.structuredContent.state, "completed");
  });

  it("rejects unknown observations and refs without touching the browser", async () => {
    const stack = track(await connectStack());
    await stack.grant();
    const snap = await stack.call("browser_snapshot", { context_id: "tab:1" });
    const wrongContext = await stack.call("browser_click", { context_id: "tab:2", observation_id: snap.structuredContent.observation_id, ref: "e1" });
    assert.equal(wrongContext.structuredContent.error.code, "STALE_OBSERVATION");
    const unknownRef = await stack.call("browser_click", { context_id: "tab:1", observation_id: snap.structuredContent.observation_id, ref: "e99" });
    assert.equal(unknownRef.structuredContent.error.reason, "ref_unknown");
    const unknownObservation = await stack.call("browser_click", { context_id: "tab:1", observation_id: "nope", ref: "e1" });
    assert.equal(unknownObservation.structuredContent.error.reason, "observation_unknown");
    assert.equal(stack.stack.pages[1].acts.length, 0);
  });

  it("a newer snapshot supersedes older observations", async () => {
    const stack = track(await connectStack());
    await stack.grant();
    const first = await stack.call("browser_snapshot", { context_id: "tab:1" });
    await stack.call("browser_snapshot", { context_id: "tab:1" });
    const stale = await stack.call("browser_click", { context_id: "tab:1", observation_id: first.structuredContent.observation_id, ref: "e1" });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.error.reason, "observation_unknown");
  });

  it("hands control to the user and cannot override them", async () => {
    const stack = track(await connectStack());
    await stack.grant();
    const snap = await stack.call("browser_snapshot", { context_id: "tab:1" });
    const handoff = await stack.call("browser_handoff", { action: "request_user_takeover", note: "Please finish MFA" });
    assert.equal(handoff.structuredContent.control.state, "user_control");

    const blocked = await stack.call("browser_click", { context_id: "tab:1", observation_id: snap.structuredContent.observation_id, ref: "e1" });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.structuredContent.outcome, "not_started");
    assert.equal(blocked.structuredContent.error.reason, "user_control");
    assert.match(textOf(blocked), /user is in control/i);

    const resume = await stack.call("browser_handoff", { action: "resume" });
    assert.equal(resume.structuredContent.control.state, "user_control");
    assert.equal(resume.structuredContent.control.resume_requested, true);
    const reclaim = await stack.call("browser_snapshot", { context_id: "tab:1" });
    assert.equal(reclaim.structuredContent.claim.claimed, false, "snapshot still works read-only");
    assert.match(textOf(reclaim), /Claim: NOT held/);

    await stack.stack.company.popup({ type: "zamery_browser_firefox_resume" });
    const fresh = await stack.call("browser_snapshot", { context_id: "tab:1" });
    assert.equal(fresh.structuredContent.claim.claimed, true);
    assert.equal((await stack.call("browser_click", { context_id: "tab:1", observation_id: fresh.structuredContent.observation_id, ref: "e1" })).isError, undefined);
  });

  it("explains the credential-field handoff instead of filling secrets", async () => {
    const stack = track(await connectStack());
    await stack.grant();
    const original = stack.stack.company.state.contentHandlers.get(1);
    stack.stack.company.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_act") return { error: { code: "USER_TAKEOVER_REQUIRED", reason: "credential_field" } };
      return original(message, tab);
    });
    const snap = await stack.call("browser_snapshot", { context_id: "tab:1" });
    const fill = await stack.call("browser_fill", { context_id: "tab:1", observation_id: snap.structuredContent.observation_id, ref: "e1", value: "hunter2-SECRET" });
    assert.equal(fill.isError, true);
    assert.equal(fill.structuredContent.outcome, "not_started");
    assert.equal((await stack.call("browser_status")).structuredContent.authorization.control.state, "user_control");
  });

  it("reports outcome_unknown loudly when the host dies mid-action, and tells the agent not to retry", async () => {
    const stack = track(await connectStack());
    await stack.grant();
    const snap = await stack.call("browser_snapshot", { context_id: "tab:1" });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = stack.stack.company.state.contentHandlers.get(1);
    stack.stack.company.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_act") await gate;
      return original(message, tab);
    });
    const pending = stack.call("browser_fill", { context_id: "tab:1", observation_id: snap.structuredContent.observation_id, ref: "e1", value: "x".repeat(20), request_id: "fixed-request-id-0001" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await stack.stack.host.kill();
    const result = await pending;
    release();
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.outcome, "outcome_unknown");
    assert.equal(result.structuredContent.request_id, "fixed-request-id-0001");
    assert.match(textOf(result), /Do NOT retry with a new request_id/);
  });

  it("opens and closes owned tabs durably and manages groups through the same server", async () => {
    const stack = track(await connectStack());
    await stack.grant({ tab_ids: [1], actions: ["inspect", "interact", "reorganize", "create_tab", "close_owned_tab"] });
    const created = await stack.call("browser_tab", { action: "create", url: "https://a.test/new", request_id: "create-tab-request-0001" });
    assert.equal(created.isError, undefined, textOf(created));
    const contextId = created.structuredContent.context_id;
    const replay = await stack.call("browser_tab", { action: "create", url: "https://a.test/new", request_id: "create-tab-request-0001" });
    assert.equal(replay.structuredContent.replayed, true);
    assert.equal(replay.structuredContent.context_id, contextId);
    assert.equal([...stack.stack.company.tabs.values()].filter((tab) => tab.url === "https://a.test/new").length, 1);

    const group = await stack.call("browser_group", { action: "create", context_ids: ["tab:1", contextId], title: "Work", color: "green" });
    assert.equal(group.isError, undefined, textOf(group));
    const handle = group.structuredContent.group.handle;
    const listed = await stack.call("browser_groups", { action: "list" });
    assert.equal(listed.structuredContent.groups[0].handle, handle);
    assert.deepEqual(listed.structuredContent.groups[0].member_context_ids.sort(), ["tab:1", contextId].sort());
    const outsider = await stack.call("browser_group", { action: "add_tabs", handle, context_ids: ["tab:2"] });
    assert.equal(outsider.isError, true);
    assert.equal(outsider.structuredContent.error.code, "OUTSIDE_SCOPE");
    const closed = await stack.call("browser_tab", { action: "close_owned", context_id: contextId });
    assert.equal(closed.isError, undefined, textOf(closed));
    const refused = await stack.call("browser_tab", { action: "close_owned", context_id: "tab:1" });
    assert.equal(refused.isError, true);
  });
});

describe("screenshots reach the model as bounded images", () => {
  async function shotStack() {
    const stack = track(await connectStack());
    stack.stack.company.state.captureFor = (opts) => (opts.format === "jpeg" ? `data:image/jpeg;base64,${JPEG.toString("base64")}` : pngDataUrl(quadrantPng(480, 320)));
    await stack.grant();
    return stack;
  }

  it("returns an ImageContent block plus compact structured metadata (no base64 in JSON)", async () => {
    const stack = await shotStack();
    const result = await stack.call("browser_screenshot", { context_id: "tab:1" });
    assert.equal(result.isError, undefined, textOf(result));
    const image = result.content.find((part) => part.type === "image");
    assert.ok(image, "an image block is returned");
    assert.equal(image.mimeType, "image/jpeg");
    assert.deepEqual(Buffer.from(image.data, "base64"), JPEG);
    assert.equal(result.structuredContent.image_included, true);
    assert.match(result.structuredContent.artifact_id, /^art_/);
    assert.ok(!JSON.stringify(result.structuredContent).includes(image.data.slice(0, 40)));
    assert.match(textOf(result), /not proof of the page's current state/);
    assert.match(textOf(result), /local file .*art_[0-9a-f]{32}\.jpg/, "a viewer-readable path is included by default");
    const call = stack.stack.company.state.captureCalls.at(-1).opts;
    assert.equal(call.format, "jpeg");
    assert.deepEqual(call.rect, { x: 0, y: 0, width: 800, height: 600 }, "viewport rect comes from the observed page geometry");
    assert.ok(call.scale <= 1 && call.scale > 0);
  });

  it("does not inline an image over the limit and says why", async () => {
    const stack = track(await connectStack());
    // Rebuild the server with a tiny inline cap.
    await stack.close();
    open.length = 0;
    const small = track(await (async () => {
      const { createFirefoxBrowserProviderV2, createFirefoxRequestId } = await import("@zamery/browser-firefox");
      const { startStack } = await import("../../browser-firefox/test/helpers/stack-harness.mjs");
      const path = await import("node:path");
      const s = await startStack();
      s.company.state.captureFor = () => `data:image/jpeg;base64,${JPEG.toString("base64")}`;
      const mcp = await connect({
        maxInlineImageBytes: 100,
        requestIdFactory: () => createFirefoxRequestId(),
        provider: () => createFirefoxBrowserProviderV2({ sessionsDir: path.join(s.roots.runtimeDir, "sessions"), audienceId: "mcp-test-consumer-0001", autoClaim: false, artifactRoot: path.join(s.roots.root, "art") }),
      });
      await mcp.call("browser_status");
      await s.company.popup({ type: "zamery_browser_firefox_grant", audience_id: "mcp-test-consumer-0001", tab_ids: [1], duration: { mode: "session" } });
      return { ...mcp, async close() { await mcp.close(); await s.stop(); } };
    })());
    const result = await small.call("browser_screenshot", { context_id: "tab:1" });
    assert.equal(result.content.some((part) => part.type === "image"), false);
    assert.equal(result.structuredContent.image_included, false);
    assert.match(textOf(result), /over the 100-byte inline limit/);
  });

  it("reads an artifact back as metadata or image, and refuses it after sharing ends", async () => {
    const stack = await shotStack();
    const shot = await stack.call("browser_screenshot", { context_id: "tab:1", include_image: false });
    assert.equal(shot.content.some((part) => part.type === "image"), false);
    const id = shot.structuredContent.artifact_id;
    const meta = await stack.call("browser_artifact_read", { artifact_id: id });
    assert.equal(meta.structuredContent.byte_size, JPEG.length);
    const image = await stack.call("browser_artifact_read", { artifact_id: id, mode: "bounded_image" });
    assert.equal(image.content.find((part) => part.type === "image").mimeType, "image/jpeg");
    await stack.stack.company.popup({ type: "zamery_browser_firefox_revoke" });
    const gone = await stack.call("browser_artifact_read", { artifact_id: id, mode: "bounded_image" });
    assert.equal(gone.isError, true);
    assert.equal(gone.structuredContent.error.code, "ARTIFACT_EXPIRED");
    assert.match(textOf(gone), /Capture a new one/);
  });

  it("can hand a verified local file path to hosts with their own image viewer", async () => {
    const stack = await shotStack();
    const shot = await stack.call("browser_screenshot", { context_id: "tab:1", local_file: true, include_image: false });
    const file = shot.structuredContent.local_path;
    assert.match(file, /art_[0-9a-f]{32}\.jpg$/);
    assert.deepEqual(fs.readFileSync(file), JPEG);
    const again = await stack.call("browser_artifact_read", { artifact_id: shot.structuredContent.artifact_id, mode: "local_file" });
    assert.equal(again.structuredContent.local_path, file);
    await stack.stack.company.popup({ type: "zamery_browser_firefox_revoke" });
    const gone = await stack.call("browser_artifact_read", { artifact_id: shot.structuredContent.artifact_id, mode: "local_file" });
    assert.equal(gone.isError, true);
    assert.equal(fs.existsSync(file), false);
  });

  it("rejects malformed artifact ids and out-of-range rects at the schema", async () => {
    const stack = await shotStack();
    for (const args of [{ artifact_id: "../../etc/passwd" }, { artifact_id: "art_short" }]) {
      const result = await stack.call("browser_artifact_read", args).catch((error) => ({ isError: true, thrown: error }));
      assert.equal(result.isError, true);
    }
    const bad = await stack.call("browser_screenshot", { context_id: "tab:1", rect: { x: 0, y: 0, width: 99999, height: 10 } }).catch((error) => ({ isError: true, thrown: error }));
    assert.equal(bad.isError, true);
  });
});
