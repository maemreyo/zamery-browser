const HOST_NAME = "com.zamery.browser_firefox";
const PROTOCOL_VERSION = 1;
const AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_COMPLETED_REQUESTS = 512;
const MAX_CAPTURE_PIXELS = 8_000_000;
const DEFAULT_MAX_ENCODED_BYTES = 8 * 1024 * 1024;
const PRIMARY_DOCUMENT_TARGET = { frameId: 0 };

let nativePort;
let profileId = "";
let browserInstanceId = "";
const ownedTabIds = new Set();
const mutationTails = new Map();
const completedRequests = new Map();
const inFlightRequests = new Map();
const cancelledRequests = new Set();
const requestPhases = new Map();
let nativeConnectAttempt = 0;
let heartbeatTimer = null;
let currentHostSessionId = null;
let currentHostProtocolVersion = null;
let authorization = {
  state: "revoked",
  host_session_id: null,
  granted_at: null,
  expires_at: null,
};

void bootstrapIdentity();

function mutationFingerprint(message) {
  return JSON.stringify({ op: message.op, params: message.params || {} });
}

async function bootstrapIdentity() {
  try {
    const stored = await browser.storage.local.get([
      "zameryBrowserFirefoxProfileId",
      "zameryBrowserFirefoxBrowserInstanceId",
      "zameryV0cProfileId",
      "zameryV0cBrowserInstanceId",
    ]);
    profileId = stored.zameryBrowserFirefoxProfileId || stored.zameryV0cProfileId || crypto.randomUUID();
    browserInstanceId = stored.zameryBrowserFirefoxBrowserInstanceId || stored.zameryV0cBrowserInstanceId || crypto.randomUUID();
    await browser.storage.local.set({
      zameryBrowserFirefoxProfileId: profileId,
      zameryBrowserFirefoxBrowserInstanceId: browserInstanceId,
    });
  } catch (error) {
    console.error("[zamery-browser-firefox] identity bootstrap failed", error);
    profileId ||= crypto.randomUUID();
    browserInstanceId ||= crypto.randomUUID();
  }
  connectNative();
}

async function recordNativeDiagnostic(patch) {
  try {
    const current = await browser.storage.local.get("zameryBrowserFirefoxNativeDiagnostic");
    await browser.storage.local.set({
      zameryBrowserFirefoxNativeDiagnostic: {
        ...(current.zameryBrowserFirefoxNativeDiagnostic || {}),
        ...patch,
        updated_at: Date.now(),
      },
    });
  } catch {}
}

function connectNative() {
  const attempt = ++nativeConnectAttempt;
  void recordNativeDiagnostic({ state: "connecting", attempt });
  try {
    nativePort = browser.runtime.connectNative(HOST_NAME);
  } catch (error) {
    console.error("[zamery-browser-firefox] connectNative failed", error);
    void recordNativeDiagnostic({ state: "connect_throw", attempt, error: String(error?.message || error) });
    setTimeout(connectNative, 1000);
    return;
  }
  void recordNativeDiagnostic({ state: "port_created", attempt });
  nativePort.onMessage.addListener((message) => {
    void recordNativeDiagnostic({ state: "message_received", attempt, message_type: String(message?.type || "unknown") });
    void onNativeMessage(message);
  });
  nativePort.onDisconnect.addListener((port) => {
    const error = port?.error?.message || browser.runtime.lastError?.message || null;
    void recordNativeDiagnostic({ state: "disconnected", attempt, error });
    nativePort = undefined;
    setTimeout(connectNative, 1000);
  });
  announceIdentity();
  void emitHeartbeat();
  if (!heartbeatTimer) heartbeatTimer = setInterval(() => void emitHeartbeat(), 5000);
}

function announceIdentity() {
  if (!nativePort || !profileId || !browserInstanceId) return;
  postNative({
    type: "hello",
    protocol_version: PROTOCOL_VERSION,
    extension_id: browser.runtime.id,
    extension_version: browser.runtime.getManifest().version,
    profile_id: profileId,
    browser_instance_id: browserInstanceId,
  });
}

function postNative(message) {
  try {
    nativePort?.postMessage(message);
  } catch (error) {
    console.error("[zamery-browser-firefox] native write failed", error);
  }
}

async function emitHeartbeat() {
  const active = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = active[0];
  postNative({
    type: "heartbeat",
    browser_instance_id: browserInstanceId,
    profile_id: profileId,
    active_context_id: typeof tab?.id === "number" ? contextIdFor(tab.id) : null,
    at: Date.now(),
  });
}

async function onNativeMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "host_status") {
    const nextSessionId = typeof message.host_session_id === "string" ? message.host_session_id : null;
    currentHostProtocolVersion = Number(message.protocol_version);
    const protocolCompatible = currentHostProtocolVersion === PROTOCOL_VERSION;
    if (nextSessionId && nextSessionId !== currentHostSessionId) {
      currentHostSessionId = nextSessionId;
      if (authorization.host_session_id !== nextSessionId) {
        authorization = { state: "revoked", host_session_id: null, granted_at: null, expires_at: null };
      }
    }
    if (!protocolCompatible) {
      authorization = { state: "revoked", host_session_id: null, granted_at: null, expires_at: null };
    }
    return;
  }
  if (message.type === "cancel" && typeof message.target_id === "string") {
    cancelledRequests.add(message.target_id);
    postNative({
      type: "cancel_ack",
      id: message.id || null,
      target_id: message.target_id,
      phase: requestPhases.get(message.target_id) || "unknown",
    });
    return;
  }
  if (message.type !== "request" || typeof message.id !== "string") return;
  const id = message.id;
  const fingerprint = mutationFingerprint(message);

  if (inFlightRequests.has(id)) {
    const inFlight = inFlightRequests.get(id);
    if (inFlight.fingerprint !== fingerprint) {
      postNative({
        type: "response",
        id,
        replayed: true,
        ok: false,
        error: { code: "REQUEST_ID_CONFLICT", message: "request id was reused with different parameters" },
        outcome: "not_started",
      });
      return;
    }
    const response = await inFlight.promise;
    postNative({ type: "response", id, replayed: true, ...response });
    return;
  }

  if (completedRequests.has(id)) {
    const completed = completedRequests.get(id);
    if (completed.fingerprint !== fingerprint) {
      postNative({
        type: "response",
        id,
        replayed: true,
        ok: false,
        error: { code: "REQUEST_ID_CONFLICT", message: "request id was reused with different parameters" },
        outcome: "not_started",
      });
      return;
    }
    postNative({ type: "response", id, replayed: true, ...completed.response });
    return;
  }

  const execution = executeRequest(message)
    .then((result) => ({ ok: true, result }))
    .catch((error) => ({
      ok: false,
      error: normalizeError(error),
      outcome: error?.outcome || "not_started",
    }));
  inFlightRequests.set(id, { fingerprint, promise: execution });
  const response = await execution;
  inFlightRequests.delete(id);

  rememberCompleted(id, fingerprint, response);
  postNative({ type: "response", id, replayed: false, ...response });
}

function rememberCompleted(id, fingerprint, response) {
  completedRequests.set(id, { fingerprint, response });
  while (completedRequests.size > MAX_COMPLETED_REQUESTS) {
    const oldest = completedRequests.keys().next().value;
    completedRequests.delete(oldest);
  }
}

function normalizeError(error) {
  return {
    code: error?.code || "BROWSER_REQUEST_FAILED",
    message: String(error?.message || error || "browser request failed").slice(0, 500),
    reason: error?.reason,
  };
}

function authorizationStatus() {
  const now = Date.now();
  const protocolCompatible = currentHostProtocolVersion === PROTOCOL_VERSION;
  const unexpired = typeof authorization.expires_at === "number" && authorization.expires_at > now;
  const granted = authorization.state === "granted"
    && Boolean(currentHostSessionId)
    && authorization.host_session_id === currentHostSessionId
    && protocolCompatible
    && unexpired;
  if (authorization.state === "granted" && !granted) {
    authorization = { state: "revoked", host_session_id: null, granted_at: null, expires_at: null };
  }
  return {
    state: granted ? "granted" : "revoked",
    current_host_session_id: currentHostSessionId,
    granted_host_session_id: granted ? authorization.host_session_id : null,
    granted_at: granted ? authorization.granted_at : null,
    expires_at: granted ? authorization.expires_at : null,
    expected_protocol_version: PROTOCOL_VERSION,
    current_host_protocol_version: currentHostProtocolVersion,
    protocol_compatible: protocolCompatible,
  };
}

function requireAuthorization() {
  const status = authorizationStatus();
  if (status.current_host_session_id && status.protocol_compatible === false) {
    const error = new Error(`Firefox companion protocol mismatch: host=${status.current_host_protocol_version} companion=${PROTOCOL_VERSION}`);
    error.code = "BROWSER_PROTOCOL_MISMATCH";
    error.reason = "native_host_protocol_version_mismatch";
    throw error;
  }
  if (status.state === "granted") return;
  const error = new Error("Firefox companion authorization is not granted for the current native-host session");
  error.code = "BROWSER_AUTHORIZATION_REQUIRED";
  error.reason = currentHostSessionId ? "current_host_session_not_granted" : "native_host_session_not_ready";
  throw error;
}

async function executeRequest(message) {
  const op = String(message.op || "");
  const params = message.params && typeof message.params === "object" ? message.params : {};

  if (op === "status") {
    return {
      protocol_version: PROTOCOL_VERSION,
      browser_family: "firefox",
      browser_instance_id: browserInstanceId,
      profile_id: profileId,
      startup_direction: "webextension-connectNative",
      managed_browser: false,
      companion_extension_id: browser.runtime.id,
      companion_extension_version: browser.runtime.getManifest().version,
      authorization: authorizationStatus(),
    };
  }

  requireAuthorization();
  if (op === "list_contexts") return listContexts();
  if (op === "snapshot") return snapshotContext(params);
  if (op === "act") return actOnContext(params, message.id);
  if (op === "create_tab") return createOwnedTab(params);
  if (op === "close_owned_tab") return closeOwnedTab(params);
  if (op === "screenshot_probe") return screenshotProbe(params);

  const error = new Error(`unsupported operation: ${op}`);
  error.code = "UNSUPPORTED_OPERATION";
  throw error;
}

function contextIdFor(tabId) {
  return `tab:${tabId}`;
}

function tabIdFromContext(contextId) {
  const match = /^tab:(\d+)$/.exec(String(contextId || ""));
  if (!match) {
    const error = new Error("invalid context id");
    error.code = "INVALID_CONTEXT";
    throw error;
  }
  return Number(match[1]);
}

function classifyUrl(url) {
  const value = String(url || "");
  if (/^(about|moz-extension|view-source):/i.test(value)) {
    return { inspect: false, act: false, screenshot: "probe", reason: "privileged_or_extension_surface" };
  }
  if (/^file:/i.test(value)) {
    return { inspect: false, act: false, screenshot: "probe", reason: "file_permission_not_declared" };
  }
  if (/^https?:/i.test(value)) {
    return { inspect: "probe", act: "probe", screenshot: "probe" };
  }
  return { inspect: false, act: false, screenshot: "probe", reason: "unsupported_scheme" };
}

function primaryDocumentTarget(browserDocumentId) {
  const value = typeof browserDocumentId === "string" ? browserDocumentId : "";
  return value ? { documentId: value } : PRIMARY_DOCUMENT_TARGET;
}

async function ensureContent(tabId) {
  try {
    return await browser.tabs.sendMessage(tabId, { type: "zamery_browser_firefox_ping" }, PRIMARY_DOCUMENT_TARGET);
  } catch (firstError) {
    try {
      await browser.tabs.executeScript(tabId, { file: "content.js", allFrames: false, runAt: "document_idle" });
      return await browser.tabs.sendMessage(tabId, { type: "zamery_browser_firefox_ping" }, PRIMARY_DOCUMENT_TARGET);
    } catch (error) {
      const wrapped = new Error(`content unavailable: ${error?.message || firstError?.message || error}`);
      wrapped.code = "CONTEXT_UNAVAILABLE";
      wrapped.reason = "content_script_injection_blocked";
      throw wrapped;
    }
  }
}

async function listContexts() {
  const tabs = await browser.tabs.query({});
  const contexts = [];
  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    const availability = classifyUrl(tab.url);
    if (availability.inspect === "probe") {
      try {
        const ping = await ensureContent(tab.id);
        availability.inspect = true;
        availability.act = true;
        availability.document_id = ping?.document_id;
        availability.browser_document_id = ping?.browser_document_id || null;
        availability.document_identity = ping?.browser_document_id ? "browser-native" : "content-epoch";
        availability.navigator_webdriver = ping?.navigator_webdriver;
      } catch (error) {
        availability.inspect = false;
        availability.act = false;
        availability.reason = error?.reason || "content_unavailable";
      }
    }
    contexts.push({
      context_id: contextIdFor(tab.id),
      tab_id: tab.id,
      window_id: tab.windowId,
      title: tab.title,
      url: tab.url,
      active: Boolean(tab.active),
      ownership: ownedTabIds.has(tab.id) ? "provider-owned" : "user-owned",
      availability,
    });
  }
  return { browser_instance_id: browserInstanceId, contexts };
}

function encodeRef(payload) {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `r1.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

function decodeRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith("r1.")) throwRef("invalid_ref_encoding");
  const raw = ref.slice(3).replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - raw.length % 4) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throwRef("invalid_ref_payload");
  }
}

function throwRef(reason) {
  const error = new Error(reason);
  error.code = "STALE_ELEMENT_REF";
  error.reason = reason;
  throw error;
}

async function snapshotContext(params) {
  const contextId = String(params.context_id || "");
  const tabId = tabIdFromContext(contextId);
  const ping = await ensureContent(tabId);
  const snapshotTarget = primaryDocumentTarget(ping?.browser_document_id);
  const snapshot = await browser.tabs.sendMessage(
    tabId,
    { type: "zamery_browser_firefox_snapshot" },
    snapshotTarget,
  );
  if (snapshot?.document_id !== ping?.document_id
    || (ping?.browser_document_id && snapshot?.browser_document_id !== ping.browser_document_id)) {
    const error = new Error("primary document changed during snapshot");
    error.code = "BROWSER_DOCUMENT_CHANGED";
    error.reason = "document_changed_during_snapshot";
    throw error;
  }
  const snapshotId = crypto.randomUUID();
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes.map((node) => ({
    ...node,
    ref: encodeRef({
      b: browserInstanceId,
      c: contextId,
      d: snapshot.document_id,
      bd: snapshot.browser_document_id || undefined,
      f: 0,
      s: snapshotId,
      n: node.node_id,
    }),
    node_id: undefined,
  })) : [];
  return {
    context_id: contextId,
    snapshot_id: snapshotId,
    document_id: snapshot?.document_id,
    browser_document_id: snapshot?.browser_document_id || null,
    document_identity: snapshot?.browser_document_id ? "browser-native" : "content-epoch",
    url: snapshot?.url,
    title: snapshot?.title,
    nodes,
  };
}

function queueMutation(contextId, fn) {
  const previous = mutationTails.get(contextId) || Promise.resolve();
  const execution = previous.catch(() => undefined).then(fn);
  const tail = execution
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (mutationTails.get(contextId) === tail) mutationTails.delete(contextId);
    });
  mutationTails.set(contextId, tail);
  return execution;
}

async function actOnContext(params, requestId) {
  const contextId = String(params.context_id || "");
  requestPhases.set(requestId, "queued");
  return queueMutation(contextId, async () => {
    if (cancelledRequests.has(requestId)) {
      cancelledRequests.delete(requestId);
      requestPhases.delete(requestId);
      const error = new Error("browser mutation cancelled before execution");
      error.code = "BROWSER_REQUEST_CANCELLED";
      error.outcome = "not_started";
      throw error;
    }

    requireAuthorization();
    const tabId = tabIdFromContext(contextId);
    const ref = decodeRef(params.ref);
    if (ref.b !== browserInstanceId) throwRef("browser_instance_changed");
    if (ref.c !== contextId) throwRef("context_changed");
    if (ref.f !== 0) throwRef("frame_changed");

    const actionTarget = primaryDocumentTarget(ref.bd);
    let currentDocument;
    try {
      currentDocument = await browser.tabs.sendMessage(
        tabId,
        { type: "zamery_browser_firefox_ping" },
        actionTarget,
      );
    } catch {
      throwRef("document_changed");
    }
    if (currentDocument?.document_id !== ref.d
      || (ref.bd && currentDocument?.browser_document_id !== ref.bd)) {
      throwRef("document_changed");
    }

    requestPhases.set(requestId, "started");
    try {
      const result = await browser.tabs.sendMessage(tabId, {
        type: "zamery_browser_firefox_act",
        document_id: ref.d,
        node_id: ref.n,
        action: params.action,
        value: params.value,
        text: params.text,
        key: params.key,
        v0c_test_delay_after_ms: params.v0c_test_delay_after_ms,
      }, actionTarget);
      if (result?.error) {
        return { outcome: "not_started", error: result.error };
      }
      if (params.v0c_test_reload_after_action === true) {
        const tab = await browser.tabs.get(tabId);
        if (!String(tab?.url || "").startsWith("http://127.0.0.1:18765/")) {
          const error = new Error("test reload hook is restricted to the V0c fixture");
          error.code = "V0C_TEST_HOOK_REFUSED";
          throw error;
        }
        browser.runtime.reload();
        await new Promise(() => {});
      }
      const cancelRequestedAfterStart = cancelledRequests.has(requestId);
      cancelledRequests.delete(requestId);
      requestPhases.delete(requestId);
      return {
        outcome: "completed",
        result,
        cancellation: cancelRequestedAfterStart
          ? { requested: true, effect: "none_after_start" }
          : { requested: false },
      };
    } catch (error) {
      cancelledRequests.delete(requestId);
      requestPhases.delete(requestId);
      const wrapped = new Error(`action response unavailable: ${error?.message || error}`);
      wrapped.code = "BROWSER_ACTION_RESPONSE_LOST";
      wrapped.outcome = "outcome_unknown";
      throw wrapped;
    }
  });
}

async function createOwnedTab(params) {
  const tab = await browser.tabs.create({ url: String(params.url || "about:blank"), active: Boolean(params.active) });
  if (typeof tab.id !== "number") throw new Error("created tab has no id");
  ownedTabIds.add(tab.id);
  return { context_id: contextIdFor(tab.id), ownership: "provider-owned" };
}

async function closeOwnedTab(params) {
  const tabId = tabIdFromContext(params.context_id);
  if (!ownedTabIds.has(tabId)) {
    const error = new Error("refusing to close user-owned tab");
    error.code = "CONTEXT_NOT_OWNED";
    throw error;
  }
  await browser.tabs.remove(tabId);
  ownedTabIds.delete(tabId);
  return { outcome: "completed" };
}

async function screenshotProbe(params) {
  const contextId = String(params.context_id || "");
  const tabId = tabIdFromContext(contextId);
  if (typeof browser.tabs.captureTab !== "function") {
    return { capability_ready: false, reason: "captureTab_unavailable" };
  }

  const ping = await ensureContent(tabId).catch(() => null);
  const viewportWidth = Number(ping?.viewport_width || 0);
  const viewportHeight = Number(ping?.viewport_height || 0);
  const rect = params.rect && typeof params.rect === "object" ? params.rect : undefined;
  const scale = Number(params.scale ?? 1);
  const width = Number(rect?.width ?? viewportWidth);
  const height = Number(rect?.height ?? viewportHeight);
  const requestedPixels = Math.ceil(width * height * scale * scale);
  if (!Number.isFinite(requestedPixels) || requestedPixels <= 0 || requestedPixels > MAX_CAPTURE_PIXELS) {
    const error = new Error(`capture pixel budget exceeded: ${requestedPixels}`);
    error.code = "SCREENSHOT_PIXEL_BUDGET_EXCEEDED";
    throw error;
  }

  const options = { format: params.format === "jpeg" ? "jpeg" : "png", scale };
  if (rect) options.rect = {
    x: Number(rect.x || 0),
    y: Number(rect.y || 0),
    width,
    height,
  };
  if (options.format === "jpeg") options.quality = Math.max(0, Math.min(100, Number(params.quality ?? 85)));

  const startedAt = performance.now();
  const dataUrl = await browser.tabs.captureTab(tabId, options);
  const captureDurationMs = Math.round(performance.now() - startedAt);
  const encoded = String(dataUrl).split(",", 2)[1] || "";
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const encodedBytes = Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
  const maxEncodedBytes = Math.max(1, Number(params.max_encoded_bytes ?? DEFAULT_MAX_ENCODED_BYTES));

  return {
    exact_tab_targeting_api: "tabs.captureTab",
    context_id: contextId,
    requested_pixels: requestedPixels,
    encoded_bytes_after_capture: encodedBytes,
    encoded_within_provider_limit: encodedBytes <= maxEncodedBytes,
    forwarded_image_bytes: false,
    capture_duration_ms: captureDurationMs,
    underlying_capture_abortable: false,
    encoded_allocation_hard_bounded_before_capture: false,
    capability_ready: false,
    reason: encodedBytes > maxEncodedBytes
      ? "encoded_result_exceeded_limit_after_Firefox_already_materialized_data_url"
      : "Firefox_captureTab_has_no_proven_abort_or_preallocation_encoded_byte_bound",
  };
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") return undefined;
  if (message.type === "zamery_browser_firefox_auth_status" || message.type === "zamery_v0c_auth_status") {
    return Promise.resolve(authorizationStatus());
  }

  const popupUrl = browser.runtime.getURL("popup.html");
  if (sender?.id !== browser.runtime.id || sender?.url !== popupUrl || sender?.tab) return undefined;

  if (message.type === "zamery_browser_firefox_grant" || message.type === "zamery_v0c_grant") {
    const status = authorizationStatus();
    if (!currentHostSessionId) {
      return Promise.resolve({ ok: false, error: "native_host_session_not_ready", ...status });
    }
    if (!status.protocol_compatible) {
      return Promise.resolve({ ok: false, error: "native_host_protocol_version_mismatch", ...status });
    }
    const now = Date.now();
    authorization = {
      state: "granted",
      host_session_id: currentHostSessionId,
      granted_at: now,
      expires_at: now + AUTHORIZATION_TTL_MS,
    };
    return Promise.resolve({ ok: true, ...authorizationStatus() });
  }

  if (message.type === "zamery_browser_firefox_revoke" || message.type === "zamery_v0c_revoke") {
    authorization = { state: "revoked", host_session_id: null, granted_at: null, expires_at: null };
    return Promise.resolve({ ok: true, ...authorizationStatus() });
  }

  return undefined;
});

browser.tabs.onRemoved.addListener((tabId) => ownedTabIds.delete(tabId));
