(() => {
  const contentDocumentId = crypto.randomUUID();
  const browserDocumentId = (() => {
    try {
      const getDocumentId = Reflect.get(browser.runtime, "getDocumentId");
      return typeof getDocumentId === "function"
        ? getDocumentId.call(browser.runtime, window)
        : null;
    } catch {
      return null;
    }
  })();
  const documentId = browserDocumentId || contentDocumentId;
  const assetRuntime = globalThis.ZameryAssetA1Experimental?.createContentAssetRuntime?.({ documentId }) || null;
  const assetDiscoveryRuntime = globalThis.ZameryAssetDiscoveryV1?.createDiscoveryRuntime?.({
    documentId,
    nodeIdForElement: nodeIdFor,
  }) || null;
  const assetTransferRuntime = assetDiscoveryRuntime
    ? globalThis.ZameryAssetTransferV1?.createTransferRuntime?.({ discoveryRuntime: assetDiscoveryRuntime }) || null
    : null;
  const nodeIds = new WeakMap();
  const nodes = new Map();
  let nextNodeId = 1;
  const MAX_SNAPSHOT_NODES = 250;
  // Counts trusted human gestures only. Synthetic events (ours or the page's) never bump it.
  let interactionGeneration = 0;
  let armed = false;

  function onHumanInteraction(event) {
    if (!event.isTrusted) return;
    interactionGeneration += 1;
    if (armed) {
      armed = false;
      try {
        void browser.runtime.sendMessage({ type: "zamery_browser_firefox_interaction" }).catch(() => undefined);
      } catch {}
    }
  }
  for (const type of ["pointerdown", "keydown", "beforeinput", "input", "change", "paste", "drop"]) {
    window.addEventListener(type, onHumanInteraction, { capture: true, passive: true });
  }

  function nodeIdFor(element) {
    let id = nodeIds.get(element);
    if (!id) {
      id = `n${nextNodeId++}`;
      nodeIds.set(element, id);
      nodes.set(id, element);
    }
    return id;
  }

  function clean(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function roleFor(element) {
    const explicit = element.getAttribute?.("role");
    if (explicit) return explicit;
    const tag = element.tagName?.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["checkbox", "radio", "button", "submit"].includes(type)) return type;
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return tag || "element";
  }

  const CREDENTIAL_AUTOCOMPLETE = /\b(one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|cc-name)\b/i;
  const CREDENTIAL_HINT = /\b(otp|totp|hotp|2fa|mfa|cvv|cvc|passcode|one[- ]?time|security code|verification code|recovery code|backup code)\b/i;
  const VALUELESS_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file", "color", "range"]);

  function isFormControl(element) {
    const tag = element.tagName?.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || Boolean(element.isContentEditable);
  }

  // Credential and one-time-code fields are a human job: the snapshot flags them and writes are refused.
  function isCredentialField(element) {
    const tag = element.tagName?.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "password") return true;
    if (CREDENTIAL_AUTOCOMPLETE.test(element.getAttribute("autocomplete") || "")) return true;
    const hint = [element.getAttribute("name"), element.id, element.getAttribute("aria-label"), element.getAttribute("placeholder")]
      .filter(Boolean)
      .join(" ")
      .replace(/[_.\-]+/g, " ");
    return CREDENTIAL_HINT.test(hint);
  }

  function labelTextFor(element) {
    const parts = [];
    const labelledBy = element.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const target = id ? document.getElementById(id) : null;
        if (target && !isFormControl(target)) parts.push(target.textContent);
      }
    }
    if (parts.length === 0 && element.labels) {
      for (const label of element.labels) parts.push(label.textContent);
    }
    return clean(parts.join(" "));
  }

  // Names describe a control; they must never carry what the user typed into it. Form controls therefore
  // never contribute innerText/textContent (textarea/contenteditable/select content is user data).
  function nameFor(element) {
    const explicit = clean(element.getAttribute?.("aria-label"));
    if (explicit) return explicit;
    if (isFormControl(element)) {
      const tag = element.tagName?.toLowerCase();
      const type = (element.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && ["button", "submit", "reset"].includes(type)) return clean(element.getAttribute("value") || labelTextFor(element));
      return labelTextFor(element) || clean(element.getAttribute("placeholder") || element.getAttribute("title") || "");
    }
    return clean(element.innerText || element.textContent || element.getAttribute?.("title") || "");
  }

  function elementSummary(element) {
    const type = (element.getAttribute?.("type") || "").toLowerCase();
    const summary = {
      node_id: nodeIdFor(element),
      role: roleFor(element),
      name: nameFor(element),
      tag: element.tagName?.toLowerCase() || "",
      type: type || undefined,
      contenteditable: Boolean(element.isContentEditable),
      connected: element.isConnected,
    };
    if (isCredentialField(element)) summary.credential = true;
    if (element instanceof HTMLInputElement && (type === "checkbox" || type === "radio") && !summary.credential) summary.checked = element.checked;
    if (element.disabled === true) summary.disabled = true;
    return summary;
  }

  function isSnapshotVisible(element) {
    if (!(element instanceof Element)) return false;
    if (element instanceof HTMLInputElement && (element.type || "").toLowerCase() === "hidden") return false;
    if (element.getAttribute?.("aria-hidden") === "true") return false;
    try {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      return element.getClientRects().length > 0;
    } catch {
      return false;
    }
  }

  function snapshot() {
    const selector = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "[contenteditable='true']",
      "[role='button']",
      "[role='textbox']",
      "[tabindex]",
      "[data-zamery-state]",
    ].join(",");
    const seen = new Set();
    const items = [];
    let truncated = false;
    for (const element of document.querySelectorAll(selector)) {
      if (!(element instanceof Element) || seen.has(element)) continue;
      if (!isSnapshotVisible(element)) continue;
      if (items.length >= MAX_SNAPSHOT_NODES) {
        truncated = true;
        break;
      }
      seen.add(element);
      items.push(elementSummary(element));
    }
    return {
      document_id: documentId,
      browser_document_id: browserDocumentId,
      url: location.href,
      title: document.title,
      frame_url: location.href,
      interaction_generation: interactionGeneration,
      coverage: { truncated, node_limit: MAX_SNAPSHOT_NODES, values_exported: false, hidden_controls_excluded: true },
      nodes: items,
    };
  }

  function resolveNode(request) {
    if (request.document_id !== documentId) {
      return { error: { code: "STALE_ELEMENT_REF", reason: "document_changed", current_document_id: documentId } };
    }
    const element = nodes.get(request.node_id);
    if (!element || !element.isConnected || !document.contains(element)) {
      return { error: { code: "STALE_ELEMENT_REF", reason: "node_replaced_or_disconnected" } };
    }
    return { element };
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function observeTrust(element, eventType, fn) {
    let trusted = null;
    const observer = (event) => { trusted = event.isTrusted; };
    element.addEventListener(eventType, observer, { capture: true, once: true });
    try {
      fn();
    } finally {
      element.removeEventListener(eventType, observer, { capture: true });
    }
    return trusted;
  }

  async function act(request) {
    const resolved = resolveNode(request);
    if (resolved.error) return resolved;
    const element = resolved.element;
    if (["fill", "type", "key"].includes(request.action) && isCredentialField(element)) {
      return { error: { code: "USER_TAKEOVER_REQUIRED", reason: "credential_field" } };
    }
    const beforeActivation = Boolean(navigator.userActivation?.isActive);
    const delayAfterMs = location.hostname === "127.0.0.1"
      ? Math.max(0, Math.min(15_000, Number(request.v0c_test_delay_after_ms || 0)))
      : 0;
    const delayAfter = () => delayAfterMs > 0
      ? new Promise((resolve) => setTimeout(resolve, delayAfterMs))
      : Promise.resolve();

    if (request.action === "click") {
      const observedTrusted = observeTrust(element, "click", () => element.click());
      await delayAfter();
      return {
        ok: true,
        mechanism: "dom-synthetic",
        observed_is_trusted: observedTrusted,
        user_activation_before: beforeActivation,
        user_activation_after: Boolean(navigator.userActivation?.isActive),
      };
    }

    if (request.action === "fill") {
      const value = String(request.value ?? "");
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        setNativeValue(element, value);
        dispatchInputEvents(element);
      } else if (element.isContentEditable) {
        element.textContent = value;
        dispatchInputEvents(element);
      } else {
        return { error: { code: "UNSUPPORTED_INPUT_SEMANTICS", reason: "element_not_fillable" } };
      }
      await delayAfter();
      return { ok: true, mechanism: "dom-synthetic", observed_is_trusted: false };
    }

    if (request.action === "type") {
      const text = String(request.text ?? "");
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        element.focus();
        const start = element.selectionStart ?? element.value.length;
        const end = element.selectionEnd ?? element.value.length;
        const value = element.value.slice(0, start) + text + element.value.slice(end);
        setNativeValue(element, value);
        element.setSelectionRange?.(start + text.length, start + text.length);
        dispatchInputEvents(element);
      } else if (element.isContentEditable) {
        return {
          error: {
            code: "UNSUPPORTED_INPUT_SEMANTICS",
            reason: "contenteditable_type_not_proven",
          },
        };
      } else {
        return { error: { code: "UNSUPPORTED_INPUT_SEMANTICS", reason: "element_not_typable" } };
      }
      await delayAfter();
      return { ok: true, mechanism: "dom-synthetic", observed_is_trusted: false };
    }

    if (request.action === "key") {
      const key = String(request.key ?? "");
      element.focus();
      const eventInit = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true };
      const trusted = observeTrust(element, "keydown", () => {
        element.dispatchEvent(new KeyboardEvent("keydown", eventInit));
        element.dispatchEvent(new KeyboardEvent("keyup", eventInit));
      });
      await delayAfter();
      return {
        ok: true,
        mechanism: "dom-synthetic",
        observed_is_trusted: trusted,
        default_behavior_guarantee: "none",
      };
    }

    if (request.action === "trusted_click" || request.action === "trusted_key") {
      return {
        error: {
          code: "UNSUPPORTED_INPUT_SEMANTICS",
          reason: "webextension_page_script_cannot_claim_trusted_input",
        },
      };
    }

    return { error: { code: "INVALID_ACTION", action: request.action } };
  }

  async function assetCall(run) {
    if (!assetRuntime) {
      return {
        ok: false,
        error: {
          code: "BROWSER_ASSET_EXPERIMENT_UNAVAILABLE",
          message: "A1 browser asset experiment is unavailable in this companion",
        },
      };
    }
    try {
      return { ok: true, result: await run() };
    } catch (error) {
      return {
        ok: false,
        error: globalThis.ZameryAssetA1Experimental.normalizeAssetError(error),
      };
    }
  }

  async function discoveryCall(run) {
    if (!assetDiscoveryRuntime) {
      return {
        ok: false,
        error: {
          code: "BROWSER_CONTEXT_GONE",
          message: "browser asset discovery is unavailable in this document",
        },
      };
    }
    try {
      return { ok: true, result: await run() };
    } catch (error) {
      return {
        ok: false,
        error: globalThis.ZameryAssetDiscoveryV1.normalizeAssetError(error),
      };
    }
  }

  async function transferCall(run) {
    if (!assetTransferRuntime) {
      return {
        ok: false,
        error: {
          code: "BROWSER_ASSET_FETCH_FAILED",
          message: "browser asset transfer is unavailable in this document",
          reason: "asset_transfer_runtime_unavailable",
        },
      };
    }
    try {
      return { ok: true, result: await run() };
    } catch (error) {
      return {
        ok: false,
        error: globalThis.ZameryAssetTransferV1.normalizeAssetError(error),
      };
    }
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return undefined;
    if (message.type === "zamery_browser_firefox_arm") {
      armed = true;
      return undefined;
    }
    if (message.type === "zamery_browser_firefox_snapshot" || message.type === "zamery_v0c_snapshot") {
      if (message.arm === true) armed = true;
      return Promise.resolve(snapshot());
    }
    if (message.type === "zamery_browser_firefox_act" || message.type === "zamery_v0c_act") return Promise.resolve(act(message));
    if (message.type === "zamery_browser_firefox_asset_discover_v1") {
      return discoveryCall(() => assetDiscoveryRuntime.discoverAssets());
    }
    if (message.type === "zamery_browser_firefox_asset_open_v1") {
      return transferCall(() => assetTransferRuntime.openAsset(message.asset_ref, {
        expected_document_id: message.expected_document_id,
        max_asset_bytes: message.max_asset_bytes,
        request_id: message.request_id,
      }));
    }
    if (message.type === "zamery_browser_firefox_asset_read_chunk_v1") {
      return transferCall(() => assetTransferRuntime.readChunk(message.asset_handle, {
        sequence: message.sequence,
        offset: message.offset,
        max_raw_bytes: message.max_raw_bytes,
        request_id: message.request_id,
      }));
    }
    if (message.type === "zamery_browser_firefox_asset_close_v1") {
      return transferCall(() => assetTransferRuntime.closeAsset(message.asset_handle, message.reason));
    }
    if (message.type === "zamery_browser_firefox_asset_cancel_request_v1") {
      return transferCall(() => assetTransferRuntime.cancelRequest(message.request_id));
    }
    if (message.type === "zamery_browser_firefox_asset_teardown_v1") {
      return transferCall(() => assetTransferRuntime.closeAll());
    }
    if (message.type === "zamery_browser_firefox_a1_asset_discover") {
      return assetCall(() => assetRuntime.discoverAssets());
    }
    if (message.type === "zamery_browser_firefox_a1_asset_open") {
      return assetCall(() => assetRuntime.openAsset(message.asset_ref, {
        expected_document_id: message.expected_document_id,
        max_asset_bytes: message.max_asset_bytes,
        request_id: message.request_id,
      }));
    }
    if (message.type === "zamery_browser_firefox_a1_asset_read_chunk") {
      return assetCall(() => assetRuntime.readChunk(message.asset_handle, {
        sequence: message.sequence,
        offset: message.offset,
        max_raw_bytes: message.max_raw_bytes,
        request_id: message.request_id,
      }));
    }
    if (message.type === "zamery_browser_firefox_a1_asset_close") {
      return assetCall(() => assetRuntime.closeAsset(message.asset_handle));
    }
    if (message.type === "zamery_browser_firefox_a1_asset_cancel_request") {
      return assetCall(() => assetRuntime.cancelRequest(message.request_id));
    }
    if (message.type === "zamery_browser_firefox_ping" || message.type === "zamery_v0c_ping") {
      if (message.arm === true) armed = true;
      return Promise.resolve({
        interaction_generation: interactionGeneration,
        document_id: documentId,
        browser_document_id: browserDocumentId,
        url: location.href,
        title: document.title,
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        scroll_x: window.scrollX,
        scroll_y: window.scrollY,
        device_pixel_ratio: window.devicePixelRatio,
        navigator_webdriver: navigator.webdriver,
        asset_discovery_v1_ready: Boolean(assetDiscoveryRuntime),
        asset_transfer_v1_ready: Boolean(assetTransferRuntime),
        a1_asset_experiment_ready: Boolean(assetRuntime),
      });
    }
    return undefined;
  });
})();
