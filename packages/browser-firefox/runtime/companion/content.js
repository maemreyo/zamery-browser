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
  const nodeIds = new WeakMap();
  const nodes = new Map();
  let nextNodeId = 1;

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

  function elementSummary(element) {
    const type = (element.getAttribute?.("type") || "").toLowerCase();
    const sensitive = type === "password";
    return {
      node_id: nodeIdFor(element),
      role: roleFor(element),
      name: clean(element.getAttribute?.("aria-label") || element.innerText || element.textContent || element.getAttribute?.("placeholder")),
      tag: element.tagName?.toLowerCase() || "",
      type: type || undefined,
      value: sensitive ? undefined : ("value" in element ? clean(element.value) : undefined),
      contenteditable: Boolean(element.isContentEditable),
      connected: element.isConnected,
    };
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
    for (const element of document.querySelectorAll(selector)) {
      if (!(element instanceof Element) || seen.has(element)) continue;
      seen.add(element);
      items.push(elementSummary(element));
      if (items.length >= 250) break;
    }
    return {
      document_id: documentId,
      browser_document_id: browserDocumentId,
      url: location.href,
      title: document.title,
      frame_url: location.href,
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

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return undefined;
    if (message.type === "zamery_browser_firefox_snapshot" || message.type === "zamery_v0c_snapshot") return Promise.resolve(snapshot());
    if (message.type === "zamery_browser_firefox_act" || message.type === "zamery_v0c_act") return Promise.resolve(act(message));
    if (message.type === "zamery_browser_firefox_ping" || message.type === "zamery_v0c_ping") {
      return Promise.resolve({
        document_id: documentId,
        browser_document_id: browserDocumentId,
        url: location.href,
        title: document.title,
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        navigator_webdriver: navigator.webdriver,
      });
    }
    return undefined;
  });
})();
