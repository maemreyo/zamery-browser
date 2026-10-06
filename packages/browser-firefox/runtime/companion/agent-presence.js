(() => {
  if (globalThis.ZameryAgentPresenceV1?.version === 1) return;

  const VERSION = 1;
  const ACTION_LIFETIME_MS = 900;
  const REDUCED_MOTION_LIFETIME_MS = 650;
  const CAPTURE_TOKEN_HARD_EXPIRY_MS = 30_000;
  const LABELS = Object.freeze({
    click: "AI · click",
    fill: "AI · fill",
    type: "AI · type",
    key: "AI · key",
  });

  let documentIdentity = null;
  let enabled = true;
  let scopeValid = true;
  let controlRevision = 0;
  let presentationEpoch = null;
  let presentationRevision = 0;
  const retiredPresentationEpochs = new Set();
  let actionGeneration = 0;
  let host = null;
  let wrapper = null;
  let ring = null;
  let label = null;
  let target = null;
  let animation = null;
  let labelAnimation = null;
  let frameId = null;
  let expiryTimer = null;
  let observer = null;
  const suppressionTokens = new Map();

  function swallow(run) {
    try { return run(); } catch { return undefined; }
  }

  function cancelCueResources() {
    swallow(() => animation?.cancel());
    swallow(() => labelAnimation?.cancel());
    animation = null;
    labelAnimation = null;
    if (frameId != null) swallow(() => cancelAnimationFrame(frameId));
    frameId = null;
    if (expiryTimer != null) swallow(() => clearTimeout(expiryTimer));
    expiryTimer = null;
    swallow(() => observer?.disconnect());
    observer = null;
    target = null;
    if (wrapper) wrapper.hidden = true;
  }

  function clear() {
    swallow(() => {
      actionGeneration += 1;
      cancelCueResources();
    });
  }

  function syncSuppressionVisibility() {
    if (host) host.style.visibility = suppressionTokens.size > 0 ? "hidden" : "";
  }

  function removeExpiredTokens(now = Date.now()) {
    let changed = false;
    for (const [token, entry] of suppressionTokens) {
      if (entry.expiresAt <= now) {
        if (entry.timer != null) swallow(() => clearTimeout(entry.timer));
        suppressionTokens.delete(token);
        changed = true;
      }
    }
    if (changed) syncSuppressionVisibility();
  }

  function isSuppressed() {
    removeExpiredTokens();
    return suppressionTokens.size > 0;
  }

  function ensureHost() {
    if (host?.isConnected && wrapper && ring && label) return true;
    const nextHost = document.createElement("div");
    nextHost.setAttribute("aria-hidden", "true");
    nextHost.dataset.zameryAgentPresence = "v1";
    Object.assign(nextHost.style, {
      all: "initial",
      position: "fixed",
      inset: "0",
      width: "0",
      height: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
    });
    const shadow = nextHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; pointer-events: none !important; }
      .wrapper { position: fixed; pointer-events: none; box-sizing: border-box; }
      .ring { position: absolute; inset: -4px; border: 3px solid rgb(93 63 211); border-radius: 8px; box-shadow: 0 0 0 2px rgb(255 255 255 / .86), 0 3px 16px rgb(28 22 61 / .25); opacity: 0; transform-origin: center; pointer-events: none; box-sizing: border-box; }
      .label { position: absolute; left: -4px; top: -29px; max-width: 160px; padding: 4px 7px; border-radius: 999px; background: rgb(42 31 86 / .96); color: white; font: 600 11px/1.2 system-ui, sans-serif; letter-spacing: .01em; white-space: nowrap; opacity: 0; pointer-events: none; box-shadow: 0 2px 10px rgb(28 22 61 / .22); }
    `;
    const nextWrapper = document.createElement("div");
    nextWrapper.className = "wrapper";
    nextWrapper.hidden = true;
    const nextRing = document.createElement("div");
    nextRing.className = "ring";
    const nextLabel = document.createElement("div");
    nextLabel.className = "label";
    nextWrapper.append(nextRing, nextLabel);
    shadow.append(style, nextWrapper);
    (document.documentElement || document.body)?.append(nextHost);
    host = nextHost;
    wrapper = nextWrapper;
    ring = nextRing;
    label = nextLabel;
    return Boolean(host.isConnected);
  }

  function positionCue(generation) {
    if (generation !== actionGeneration || !target || !wrapper) return;
    if (!target.isConnected || target.ownerDocument !== document) {
      clear();
      return;
    }
    const rect = target.getBoundingClientRect();
    wrapper.style.left = `${rect.left}px`;
    wrapper.style.top = `${rect.top}px`;
    wrapper.style.width = `${rect.width}px`;
    wrapper.style.height = `${rect.height}px`;
    frameId = requestAnimationFrame(() => {
      try { positionCue(generation); } catch { clear(); }
    });
  }

  function reducedMotionRequested() {
    return swallow(() => matchMedia("(prefers-reduced-motion: reduce)").matches) === true;
  }

  function showAction(element, action) {
    try {
      if (!enabled || !scopeValid || isSuppressed()) return;
      if (!(element instanceof Element) || !element.isConnected || element.ownerDocument !== document) return;
      const text = LABELS[action];
      if (!text || !ensureHost()) return;

      actionGeneration += 1;
      const generation = actionGeneration;
      cancelCueResources();
      target = element;
      label.textContent = text;
      wrapper.hidden = false;
      positionCue(generation);

      const reduced = reducedMotionRequested();
      const lifetime = reduced ? REDUCED_MOTION_LIFETIME_MS : ACTION_LIFETIME_MS;
      if (reduced) {
        ring.style.opacity = "1";
        ring.style.transform = "scale(1)";
        label.style.opacity = "1";
      } else {
        ring.style.opacity = "";
        ring.style.transform = "";
        label.style.opacity = "";
        animation = ring.animate([
          { opacity: 0.2, transform: "scale(.94)" },
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(1.035)" },
        ], { duration: lifetime, easing: "ease-out", fill: "none" });
        labelAnimation = label.animate([
          { opacity: 0 },
          { opacity: 1, offset: 0.18 },
          { opacity: 0 },
        ], { duration: lifetime, easing: "ease-out", fill: "none" });
      }

      expiryTimer = setTimeout(() => {
        try {
          if (generation !== actionGeneration) return;
          clear();
        } catch {}
      }, lifetime);
    } catch {
      clear();
    }
  }

  function bindDocument(documentId) {
    swallow(() => {
      const next = String(documentId || "");
      if (!next) return;
      if (documentIdentity && documentIdentity !== next) {
        clear();
        for (const entry of suppressionTokens.values()) if (entry.timer != null) swallow(() => clearTimeout(entry.timer));
        suppressionTokens.clear();
        presentationEpoch = null;
        presentationRevision = 0;
        retiredPresentationEpochs.clear();
      }
      documentIdentity = next;
    });
    return api;
  }

  function acceptPresentationMessage(input = {}) {
    const epoch = typeof input.presentation_epoch === "string" ? input.presentation_epoch : "";
    const revision = Number(input.presentation_revision);
    if (!epoch || !Number.isSafeInteger(revision) || revision <= 0) {
      return { ok: false, reason: "invalid_presentation_revision" };
    }
    if (retiredPresentationEpochs.has(epoch)) return { ok: false, reason: "stale_presentation_epoch" };
    if (presentationEpoch && epoch !== presentationEpoch) {
      retiredPresentationEpochs.add(presentationEpoch);
      presentationEpoch = epoch;
      presentationRevision = 0;
    } else if (!presentationEpoch) {
      presentationEpoch = epoch;
    }
    if (revision < presentationRevision) return { ok: false, reason: "stale_presentation_revision" };
    const advanced = revision > presentationRevision;
    presentationRevision = revision;
    return { ok: true, advanced };
  }

  function syncScope(input = {}) {
    return swallow(() => {
      if (input.expected_document_id && input.expected_document_id !== documentIdentity) {
        return { ok: false, reason: "document_mismatch", document_id: documentIdentity };
      }
      const presentation = acceptPresentationMessage(input);
      if (!presentation.ok) return { ...presentation, document_id: documentIdentity, presentation_revision: presentationRevision };
      const nextRevision = Number(input.control_revision) || 0;
      const revisionChanged = nextRevision !== controlRevision;
      controlRevision = nextRevision;
      enabled = input.enabled !== false;
      scopeValid = input.scope_valid !== false;
      if (revisionChanged || !enabled || !scopeValid) clear();
      return {
        ok: true,
        document_id: documentIdentity,
        enabled,
        scope_valid: scopeValid,
        control_revision: controlRevision,
        presentation_epoch: presentationEpoch,
        presentation_revision: presentationRevision,
      };
    }) || { ok: false, reason: "presentation_error", document_id: documentIdentity };
  }

  function clearPresentation(input = {}) {
    return swallow(() => {
      if (input.expected_document_id !== documentIdentity) {
        return { ok: false, reason: "document_mismatch", document_id: documentIdentity };
      }
      const presentation = acceptPresentationMessage(input);
      if (!presentation.ok) return { ...presentation, document_id: documentIdentity, presentation_revision: presentationRevision };
      if (Number.isFinite(Number(input.control_revision))) controlRevision = Number(input.control_revision);
      clear();
      return {
        ok: true,
        document_id: documentIdentity,
        control_revision: controlRevision,
        presentation_epoch: presentationEpoch,
        presentation_revision: presentationRevision,
      };
    }) || { ok: false, reason: "presentation_error", document_id: documentIdentity };
  }

  function suppress(token, expectedDocument, requestedExpiry) {
    return swallow(() => {
      const key = String(token || "");
      if (!key || !documentIdentity || expectedDocument !== documentIdentity) {
        return { ok: false, reason: "document_mismatch", document_id: documentIdentity };
      }
      removeExpiredTokens();
      const existing = suppressionTokens.get(key);
      if (existing && existing.documentIdentity !== expectedDocument) {
        return { ok: false, reason: "token_document_mismatch", document_id: documentIdentity };
      }
      const now = Date.now();
      const expiresAt = Math.min(
        Number.isFinite(Number(requestedExpiry)) ? Number(requestedExpiry) : now + CAPTURE_TOKEN_HARD_EXPIRY_MS,
        now + CAPTURE_TOKEN_HARD_EXPIRY_MS,
      );
      if (!existing) {
        const entry = { documentIdentity: expectedDocument, issuedAt: now, expiresAt, timer: null };
        entry.timer = setTimeout(() => {
          try {
            const current = suppressionTokens.get(key);
            if (current === entry) {
              suppressionTokens.delete(key);
              syncSuppressionVisibility();
            }
          } catch {}
        }, Math.max(0, expiresAt - now));
        suppressionTokens.set(key, entry);
      }
      clear();
      syncSuppressionVisibility();
      void document.documentElement?.getBoundingClientRect?.();
      return { ok: true, state: "suppression_applied", token: key, document_id: documentIdentity, suppression_active: true };
    }) || { ok: false, reason: "presentation_error", document_id: documentIdentity };
  }

  async function confirmSuppression(token, expectedDocument) {
    const key = String(token || "");
    try {
      removeExpiredTokens();
      const active = suppressionTokens.get(key);
      if (!active || expectedDocument !== documentIdentity || active.documentIdentity !== expectedDocument) {
        return { ok: false, reason: "suppression_not_active", document_id: documentIdentity };
      }
      if (document.visibilityState === "visible") {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        removeExpiredTokens();
        const current = suppressionTokens.get(key);
        if (!current || current.documentIdentity !== expectedDocument || expectedDocument !== documentIdentity) {
          return { ok: false, reason: "suppression_not_active", document_id: documentIdentity };
        }
        return { ok: true, state: "suppression_confirmed", token: key, document_id: documentIdentity, suppression_active: true, paint_barrier: "foreground-double-raf" };
      }
      if (host) host.style.visibility = "hidden";
      void document.documentElement?.getBoundingClientRect?.();
      await Promise.resolve();
      removeExpiredTokens();
      const current = suppressionTokens.get(key);
      if (!current || current.documentIdentity !== expectedDocument || expectedDocument !== documentIdentity) {
        return { ok: false, reason: "suppression_not_active", document_id: documentIdentity };
      }
      return { ok: true, state: "suppression_confirmed", token: key, document_id: documentIdentity, suppression_active: true, paint_barrier: "background-roundtrip-unproven" };
    } catch {
      return { ok: false, reason: "presentation_error", document_id: documentIdentity };
    }
  }

  function release(token, expectedDocument) {
    return swallow(() => {
      const key = String(token || "");
      if (expectedDocument !== documentIdentity) return { ok: false, reason: "document_mismatch", document_id: documentIdentity };
      const entry = suppressionTokens.get(key);
      if (entry?.timer != null) swallow(() => clearTimeout(entry.timer));
      suppressionTokens.delete(key);
      removeExpiredTokens();
      syncSuppressionVisibility();
      return { ok: true, state: "suppression_released", token: key, document_id: documentIdentity, suppression_active: suppressionTokens.size > 0 };
    }) || { ok: false, reason: "presentation_error", document_id: documentIdentity };
  }

  function status() {
    removeExpiredTokens();
    return {
      version: VERSION,
      document_id: documentIdentity,
      enabled,
      scope_valid: scopeValid,
      control_revision: controlRevision,
      presentation_epoch: presentationEpoch,
      presentation_revision: presentationRevision,
      action_generation: actionGeneration,
      suppressed: suppressionTokens.size > 0,
      suppression_count: suppressionTokens.size,
    };
  }

  const api = Object.freeze({ version: VERSION, bindDocument, syncScope, clearPresentation, showAction, clear, suppress, confirmSuppression, release, status });
  globalThis.ZameryAgentPresenceV1 = api;
})();
