import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPolicy } from "./helpers/load-policy.mjs";

const policy = loadPolicy();
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

describe("duration bounds", () => {
  it("defaults to session", () => {
    assert.deepEqual(policy.normalizeDuration(undefined), { ok: true, mode: "session", days: null });
    assert.deepEqual(policy.normalizeDuration({ mode: "session" }), { ok: true, mode: "session", days: null });
  });
  it("accepts presets without custom intent", () => {
    for (const days of [1, 3, 7, 14, 30]) assert.deepEqual(policy.normalizeDuration({ mode: "fixed", days }), { ok: true, mode: "fixed", days });
  });
  it("requires explicit intent for non-preset days and enforces 1..30", () => {
    assert.equal(policy.normalizeDuration({ mode: "fixed", days: 5 }).error, "custom_authorization_duration_requires_explicit_intent");
    assert.deepEqual(policy.normalizeDuration({ mode: "fixed", days: 5 }, { allowCustom: true }), { ok: true, mode: "fixed", days: 5 });
    for (const days of [0, -1, 31, 90, 1.5, NaN, Infinity, "7", null, undefined, 2 ** 53]) {
      assert.equal(policy.normalizeDuration({ mode: "fixed", days }, { allowCustom: true }).error, "invalid_authorization_duration", String(days));
    }
  });
  it("rejects unknown modes including until-revoked", () => {
    assert.equal(policy.normalizeDuration({ mode: "forever" }).ok, false);
    assert.equal(policy.normalizeDuration({ mode: "until_revoked" }).ok, false);
  });
  it("computes the exact deadline", () => {
    assert.equal(policy.computeExpiry(NOW, 7), NOW + 7 * 24 * 60 * 60 * 1000);
  });
});

describe("actions", () => {
  it("defaults to inspect/interact/capture and never grants destructive actions implicitly", () => {
    assert.deepEqual(policy.normalizeActions(undefined), ["inspect", "interact", "capture"]);
    assert.deepEqual(policy.normalizeActions([]), ["inspect", "interact", "capture"]);
  });
  it("drops unknown actions and always includes inspect", () => {
    assert.deepEqual(policy.normalizeActions(["interact", "eval", "root"]), ["inspect", "interact"]);
  });
});

describe("consent lifecycle", () => {
  const base = { now: NOW, grantId: "g1", trustedProfileId: "p1", audienceId: "audience-1", duration: { mode: "fixed", days: 7 }, actions: undefined, scopeSummary: { kind: "tabs", count: 1, origins: ["https://a.test", "https://a.test"] } };

  it("keeps lifetime separate from live identity", () => {
    const consent = policy.buildConsent(base);
    assert.equal(consent.expiresAt, NOW + 7 * policy.DAY_MS);
    assert.equal(consent.restartPolicy, "explicit_rebind");
    assert.equal(consent.groupPolicy, "membership_snapshot");
    assert.deepEqual(consent.scopeSummary.origins, ["https://a.test"]);
    const serialized = JSON.stringify(consent);
    assert.ok(!/tabId|tab_ids|groupId|"title"/.test(serialized), "consent must not carry numeric tab/group identity or titles");
  });
  it("rebinding keeps the original deadline and grant id", () => {
    const first = policy.buildConsent(base);
    const later = NOW + 3 * policy.DAY_MS;
    const rebound = policy.buildConsent({ ...base, now: later, previous: first, scopeSummary: { kind: "tabs", count: 2, origins: [] } });
    assert.equal(rebound.grantId, first.grantId);
    assert.equal(rebound.issuedAt, first.issuedAt);
    assert.equal(rebound.expiresAt, first.expiresAt);
    assert.equal(rebound.grantRevision, 2);
    assert.equal(rebound.lastSeenAt, later);
  });
  it("expires exactly at the deadline", () => {
    const consent = policy.buildConsent(base);
    assert.equal(policy.consentExpired(consent, consent.expiresAt - 1), false);
    assert.equal(policy.consentExpired(consent, consent.expiresAt), true);
    assert.equal(policy.consentExpired(policy.buildConsent({ ...base, duration: { mode: "session", days: null } }), NOW * 10), false);
  });
  it("flags wall-clock regression beyond tolerance only", () => {
    const consent = policy.buildConsent(base);
    assert.equal(policy.clockRegressed(consent, NOW - 60_000), false);
    assert.equal(policy.clockRegressed(consent, NOW - policy.CLOCK_REGRESSION_TOLERANCE_MS - 1), true);
  });
  it("round-trips persisted consent and rejects tampered or session records", () => {
    const consent = policy.buildConsent(base);
    assert.ok(policy.parseStoredConsent(JSON.parse(JSON.stringify(consent))));
    assert.equal(policy.parseStoredConsent({ ...consent, expiresAt: consent.expiresAt + 1 }), null, "deadline must equal issuedAt + days");
    assert.equal(policy.parseStoredConsent({ ...consent, durationDays: 90, expiresAt: consent.issuedAt + 90 * policy.DAY_MS }), null);
    assert.equal(policy.parseStoredConsent({ ...consent, schemaVersion: 2 }), null);
    assert.equal(policy.parseStoredConsent({ ...consent, mode: "session" }), null);
    assert.equal(policy.parseStoredConsent("nope"), null);
  });
});

describe("tab access evaluation", () => {
  const scope = { tabs: { 1: { origin: "https://a.test", partition: "firefox-default" }, 2: { origin: "https://b.test", viaGroup: "grp-1" } }, groups: { "grp-1": { nativeGroupId: 9 } } };
  const actions = ["inspect", "interact"];
  const tab = (over) => ({ id: 1, url: "https://a.test/x?q=1", incognito: false, cookieStoreId: "firefox-default", groupId: -1, ...over });
  const check = (t, action = "inspect", extra = {}) => policy.evaluateTabAccess({ scope, actions, ...extra }, t, action);

  it("allows an in-scope tab at its recorded origin", () => assert.deepEqual(check(tab()), { ok: true }));
  it("denies tabs that were never granted", () => assert.equal(check(tab({ id: 3 })).reason, "outside_scope"));
  it("denies actions outside the grant", () => assert.equal(check(tab(), "capture").reason, "action_outside_scope"));
  it("denies private windows regardless of grant", () => assert.equal(check(tab({ incognito: true })).reason, "private_window_denied"));
  it("denies when the origin changes until confirmed", () => {
    assert.equal(check(tab({ url: "https://evil.test/" })).reason, "origin_changed_confirmation_required");
    assert.equal(check(tab(), "inspect", { pendingOrigins: { 1: { to: "x" } } }).reason, "origin_changed_confirmation_required");
  });
  it("denies restricted schemes", () => assert.equal(check(tab({ url: "about:config" })).reason, "restricted_or_unsupported_page"));
  it("denies a container/partition change", () => assert.equal(check(tab({ cookieStoreId: "firefox-container-1" })).reason, "partition_changed"));
  it("group-derived access requires current membership", () => {
    assert.deepEqual(check(tab({ id: 2, url: "https://b.test/", groupId: 9 })), { ok: true });
    assert.equal(check(tab({ id: 2, url: "https://b.test/", groupId: -1 })).reason, "left_authorized_group");
    assert.equal(check(tab({ id: 2, url: "https://b.test/", groupId: 10 })).reason, "left_authorized_group");
  });
});

describe("control state machine", () => {
  const apply = (control, event, now = NOW) => {
    const result = policy.transition(control, event, now);
    assert.ok(result.ok, JSON.stringify(result));
    return result.control;
  };
  const granted = () => apply(policy.createControl(), { type: "grant" });
  const claimed = (control = granted()) => apply(control, { type: "claim", contextId: "tab:1", audienceId: "aud-1", leaseId: "lease-1" });

  it("starts without access and cannot be claimed", () => {
    assert.equal(policy.transition(policy.createControl(), { type: "claim", contextId: "tab:1", audienceId: "a" }).reason, "not_granted");
  });
  it("walks the hero path and bumps the generation at every transition", () => {
    const g0 = granted();
    const c1 = claimed(g0);
    const u2 = apply(c1, { type: "takeover", reason: "user_takeover" });
    const s3 = apply(u2, { type: "resume" });
    const c4 = claimed(s3);
    assert.deepEqual([g0.state, c1.state, u2.state, s3.state, c4.state], ["shared_idle", "agent_claimed", "user_control", "shared_idle", "agent_claimed"]);
    const generations = [g0, c1, u2, s3, c4].map((c) => c.claimGeneration);
    assert.deepEqual(generations, [...generations].sort((a, b) => a - b));
    assert.equal(new Set(generations).size, generations.length);
  });
  it("agent cannot override user control; it can only request resume", () => {
    const user = apply(claimed(), { type: "takeover", reason: "popup" });
    assert.equal(policy.transition(user, { type: "claim", contextId: "tab:1", audienceId: "aud-1" }).reason, "user_control");
    const requested = apply(user, { type: "request_resume" });
    assert.equal(requested.state, "user_control");
    assert.equal(requested.resumeRequested, true);
    assert.equal(requested.claimGeneration, user.claimGeneration, "a request does not change generation");
    assert.equal(apply(requested, { type: "resume" }).resumeRequested, false);
  });
  it("only the claiming audience may re-claim, and a re-claim invalidates the old generation", () => {
    const first = claimed();
    assert.equal(policy.transition(first, { type: "claim", contextId: "tab:2", audienceId: "aud-2" }).reason, "claimed_by_other_consumer");
    const again = apply(first, { type: "claim", contextId: "tab:1", audienceId: "aud-1", leaseId: "lease-2" });
    assert.ok(again.claimGeneration > first.claimGeneration);
  });
  it("revoke and rebind drop the claim", () => {
    assert.equal(apply(claimed(), { type: "revoke", reason: "expired" }).state, "no_access");
    const rebinding = apply(claimed(), { type: "rebind_required", reason: "browser_restart" });
    assert.equal(rebinding.state, "rebinding");
    assert.equal(rebinding.claimedContextId, null);
  });
  it("closing the claimed context releases the claim; other contexts are ignored", () => {
    const c = claimed();
    assert.deepEqual(apply(c, { type: "context_gone", contextId: "tab:9" }), c);
    assert.equal(apply(c, { type: "context_gone", contextId: "tab:1" }).state, "shared_idle");
  });

  describe("write claim guard", () => {
    const base = { contextId: "tab:1", audienceId: "aud-1" };
    it("allows only the exact claimed context, audience and generation", () => {
      const c = claimed();
      assert.deepEqual(policy.checkWriteClaim(c, { ...base, claimGeneration: c.claimGeneration }), { ok: true });
      assert.equal(policy.checkWriteClaim(c, { ...base, claimGeneration: c.claimGeneration - 1 }).reason, "claim_changed");
      assert.equal(policy.checkWriteClaim(c, { ...base, contextId: "tab:2", claimGeneration: c.claimGeneration }).reason, "claim_context_changed");
      assert.equal(policy.checkWriteClaim(c, { ...base, audienceId: "aud-2", claimGeneration: c.claimGeneration }).reason, "claimed_by_other_consumer");
    });
    it("refuses without a claim and during user control", () => {
      const idle = granted();
      assert.equal(policy.checkWriteClaim(idle, { ...base, claimGeneration: idle.claimGeneration }).reason, "claim_required");
      const user = apply(claimed(), { type: "takeover" });
      assert.equal(policy.checkWriteClaim(user, { ...base, claimGeneration: user.claimGeneration }).reason, "user_control");
    });
  });
});
