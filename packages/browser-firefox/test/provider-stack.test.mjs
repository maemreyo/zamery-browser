import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createFirefoxBrowserProviderV2, createFirefoxRequestId } from "../dist/index.js";
import { startStack } from "./helpers/stack-harness.mjs";
import { settle } from "./helpers/companion-harness.mjs";

const AUD = "audience-stack-aaaa";
const stacks = [];
afterEach(async () => { while (stacks.length) await stacks.pop().stop(); });

async function boot(options = {}) {
  const stack = await startStack(options);
  stacks.push(stack);
  const sessionsDir = path.join(stack.roots.runtimeDir, "sessions");
  const providerFor = (audienceId = AUD) => createFirefoxBrowserProviderV2({ sessionsDir, audienceId, clientLabel: "Stack test" });
  const provider = providerFor();
  await provider.status(); // a connected agent registers itself so the user can choose it in the popup
  const [instance] = await provider.listInstances();
  const target = { browserInstanceId: instance.browserInstanceId, providerSessionId: instance.providerSessionId };
  return { stack, provider, providerFor, target, instance };
}

async function grant(stack, extra = {}) {
  const result = await stack.company.popup({ type: "zamery_browser_firefox_grant", tab_ids: [1], audience_id: AUD, duration: { mode: "session" }, ...extra });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

describe("BrowserProvider V2 over the real broker, host and companion", () => {
  it("walks the single-tab hero path: inspect -> claim -> act -> takeover -> resume, with a second tab invisible", async () => {
    const { stack, provider, target } = await boot();
    const before = await provider.authorizationDetail(target);
    assert.equal(before.state, "revoked");
    assert.equal((await provider.status()).authorization.state, "revoked");

    await grant(stack, { duration: { mode: "fixed", days: 7 } });
    const detail = await provider.authorizationDetail(target);
    assert.equal(detail.state, "granted");
    assert.equal(detail.mode, "fixed");
    assert.equal(detail.durationDays, 7);
    assert.deepEqual([...detail.actions], ["inspect", "interact", "capture"]);
    assert.equal(detail.scope.count, 1);
    assert.equal(detail.restartPolicy, "explicit_rebind");

    const contexts = await provider.listContexts(target);
    assert.deepEqual(contexts.map((c) => c.contextId), ["tab:1"]);
    assert.ok(!JSON.stringify(contexts).includes("Private page"));
    await assert.rejects(provider.snapshot({ ...target, contextId: "tab:2" }), (error) => error.code === "BROWSER_AUTHORIZATION_REQUIRED" && error.reason === "outside_scope");

    const claim = await provider.claim({ ...target, contextId: "tab:1" });
    assert.equal(claim.outcome, "completed");
    assert.equal(claim.value.contextId, "tab:1");
    const snapshot = await provider.snapshot({ ...target, contextId: "tab:1" });
    assert.equal(snapshot.coverage?.truncated, false);
    const node = snapshot.nodes[0];
    const requestId = createFirefoxRequestId();
    const click = await provider.act({
      requestId, ...target, contextId: "tab:1",
      action: { capability: "action.click", ref: node.ref, observationId: snapshot.observationId },
    });
    assert.equal(click.outcome, "completed", JSON.stringify(click));
    assert.equal(click.receipt.observed.targetValidation.basis, "action-time-validated");
    assert.equal(stack.pages[1].acts.length, 1);

    // The host journal answers an exact replay without dispatching again.
    const replay = await provider.act({
      requestId, ...target, contextId: "tab:1",
      action: { capability: "action.click", ref: node.ref, observationId: snapshot.observationId },
    });
    assert.equal(replay.outcome, "completed");
    assert.equal(replay.replayed, true);
    assert.equal(stack.pages[1].acts.length, 1);

    // Takeover: writes refused with the right reason; the agent can only ask to resume.
    await stack.company.popup({ type: "zamery_browser_firefox_takeover" });
    const refused = await provider.act({
      requestId: createFirefoxRequestId(), ...target, contextId: "tab:1",
      action: { capability: "action.click", ref: node.ref, observationId: snapshot.observationId },
    });
    assert.equal(refused.outcome, "not_started");
    assert.equal(refused.error.reason, "user_control");
    const asked = await provider.requestResume(target);
    assert.equal(asked.state, "user_control");
    assert.equal(asked.resumeRequested, true);
    await stack.company.popup({ type: "zamery_browser_firefox_resume" });
    assert.equal((await provider.controlState(target)).state, "shared_idle");
  });

  it("rejects another consumer audience through the whole stack", async () => {
    const { stack, providerFor, target } = await boot();
    await grant(stack);
    const intruder = providerFor("audience-intruder-bbb");
    await intruder.status();
    await assert.rejects(intruder.listContexts(target), (error) => error.reason === "audience_mismatch");
    const detail = await intruder.authorizationDetail(target);
    assert.equal(detail.state, "revoked");
    assert.equal(detail.reason, "bound_to_other_consumer");
    assert.equal(detail.scope.count, 0);
  });

  it("reports outcome_unknown, never a thrown error, when the host dies after dispatch; and a retry never re-runs it", async () => {
    const { stack, provider, target } = await boot();
    await grant(stack);
    await provider.claim({ ...target, contextId: "tab:1" });
    const snapshot = await provider.snapshot({ ...target, contextId: "tab:1" });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = stack.company.state.contentHandlers.get(1);
    stack.company.state.contentHandlers.set(1, async (message, tab) => {
      if (message.type === "zamery_browser_firefox_act") { await gate; }
      return original(message, tab);
    });
    const requestId = createFirefoxRequestId();
    const pending = provider.act({
      requestId, ...target, contextId: "tab:1",
      action: { capability: "action.fill", ref: snapshot.nodes[0].ref, observationId: snapshot.observationId, value: "SECRET-FILL-VALUE" },
    });
    await settle(150);
    await stack.host.kill();
    const result = await pending;
    assert.equal(result.outcome, "outcome_unknown");
    assert.equal(result.error.code, "MUTATION_OUTCOME_UNKNOWN");
    release();
    // The secret never reached disk even though the host was killed mid-flight.
    const { readAllFiles } = await import("./helpers/native-host-harness.mjs");
    for (const file of readAllFiles(stack.roots.stateDir)) assert.ok(!file.text.includes("SECRET-FILL-VALUE"));
  });

  it("makes owned-tab creation durable: the same request id never opens a second tab", async () => {
    const { stack, provider, target } = await boot();
    await grant(stack, { actions: ["inspect", "interact", "create_tab", "close_owned_tab"] });
    const requestId = createFirefoxRequestId();
    const first = await provider.createTab({ requestId, ...target, url: "https://a.test/new" });
    assert.equal(first.outcome, "completed", JSON.stringify(first));
    assert.equal(first.value.ownership, "provider-owned");
    const again = await provider.createTab({ requestId, ...target, url: "https://a.test/new" });
    assert.equal(again.outcome, "completed");
    assert.equal(again.replayed, true);
    assert.equal(again.value.contextId, first.value.contextId);
    assert.equal([...stack.company.tabs.values()].filter((tab) => tab.url === "https://a.test/new").length, 1);

    const status = await provider.mutationStatus({ ...target, requestId });
    assert.equal(status.state, "completed");
    assert.equal(status.outcome, "completed");
    assert.equal(status.operation, "create_tab");

    const closed = await provider.closeOwnedTab({ requestId: createFirefoxRequestId(), ...target, contextId: first.value.contextId });
    assert.equal(closed.outcome, "completed");
    const refused = await provider.closeOwnedTab({ requestId: createFirefoxRequestId(), ...target, contextId: "tab:1" });
    assert.equal(refused.outcome, "not_started");
    assert.equal(refused.error.code, "OUTSIDE_SCOPE");
  });

  it("surfaces a missing host as not_started HOST_MISSING for control mutations", async () => {
    const provider = createFirefoxBrowserProviderV2({ sessionsDir: "/tmp/zq-does-not-exist", audienceId: AUD });
    const result = await provider.createTab({ requestId: createFirefoxRequestId(), browserInstanceId: "none", url: "https://a.test/" });
    assert.equal(result.outcome, "not_started");
    assert.equal(result.error.code, "HOST_MISSING");
  });
});
