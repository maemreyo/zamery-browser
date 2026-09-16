const HOST_NAME = "com.zamery.browser_firefox";
const PROTOCOL_VERSION = 1;
const AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_COMPLETED_REQUESTS = 512;
const MAX_CAPTURE_PIXELS = 8_000_000;
const DEFAULT_MAX_ENCODED_BYTES = 8 * 1024 * 1024;
const PRIMARY_DOCUMENT_TARGET = { frameId: 0 };
const A1_DEVELOPMENT_EXTENSION_ID = "zamery-live-browser-v0c@zamery.local";
const A1_REGISTRY_TTL_MS = 5 * 60 * 1000;
const A1_MAX_ASSET_REFS = 256;
const A1_MAX_ACTIVE_TRANSFERS = 8;
const A1_CONTENT_RPC_TIMEOUT_MS = 5_000;
const ASSET_V1_REGISTRY_TTL_MS = 5 * 60 * 1000;
const ASSET_V1_TRANSFER_TTL_MS = 2 * 60 * 1000;
const ASSET_V1_MAX_REFS = 256;
const ASSET_V1_MAX_ACTIVE_TRANSFERS = 8;
const ASSET_DISCOVERY_CONTENT_RPC_TIMEOUT_MS = 5_000;
const ASSET_TRANSFER_CONTENT_RPC_TIMEOUT_MS = 35_000;

let nativePort;
let profileId = "";
let browserInstanceId = "";
const ownedTabIds = new Set();
const mutationTails = new Map();
const completedRequests = new Map();
const inFlightRequests = new Map();
const cancelledRequests = new Set();
const requestPhases = new Map();
const a1AssetRefs = new Map();
const assetV1Refs = new Map();
const assetV1Transfers = new Map();
const assetV1RequestContexts = new Map();
const a1Transfers = new Map();
const a1RequestContexts = new Map();
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
    void teardownAssetV1Transfers("native_disconnect");
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
    const assetV1Target = assetV1RequestContexts.get(message.target_id);
    if (assetV1Target) {
      void browser.tabs.sendMessage(
        assetV1Target.tab_id,
        { type: "zamery_browser_firefox_asset_cancel_request_v1", request_id: message.target_id },
        { frameId: 0 },
      ).catch(() => undefined);
    }
    const a1Target = a1RequestContexts.get(message.target_id);
    if (a1Target) {
      void browser.tabs.sendMessage(
        a1Target.tab_id,
        { type: "zamery_browser_firefox_a1_asset_cancel_request", request_id: message.target_id },
        { frameId: 0 },
      ).catch(() => undefined);
    }
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

  rememberCompleted(id, fingerprint, response, message.op);
  postNative({ type: "response", id, replayed: false, ...response });
}

function rememberCompleted(id, fingerprint, response, op) {
  if (op === "asset_read_chunk_v1" || op === "a1_asset_read_chunk") return;
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
  if (op === "asset_capabilities_v1") return assetCapabilitiesV1(params);
  if (op === "asset_discover_v1") return assetDiscoverV1(params);
  if (op === "asset_open_v1") return assetOpenV1(params, message.id);
  if (op === "asset_read_chunk_v1") return assetReadChunkV1(params, message.id);
  if (op === "asset_close_v1") return assetCloseV1(params, message.id);
  if (op === "a1_asset_discover") return a1AssetDiscover(params, message.id);
  if (op === "a1_asset_open") return a1AssetOpen(params, message.id);
  if (op === "a1_asset_read_chunk") return a1AssetReadChunk(params, message.id);
  if (op === "a1_asset_close") return a1AssetClose(params, message.id);

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

async function ensureAssetDiscoveryContent(tabId) {
  try {
    const ping = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
    if (ping?.asset_discovery_v1_ready) return ping;
  } catch {}
  try {
    await browser.tabs.executeScript(tabId, {
      file: "asset-discovery-v1.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    await browser.tabs.executeScript(tabId, {
      file: "asset-transfer-v1.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    await browser.tabs.executeScript(tabId, {
      file: "content.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    const ping = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
    if (ping?.asset_discovery_v1_ready) return ping;
    throw new Error("asset discovery helper did not initialize");
  } catch (error) {
    const wrapped = new Error("browser asset discovery content is unavailable");
    wrapped.code = "BROWSER_CONTEXT_GONE";
    wrapped.reason = "asset_discovery_content_unavailable";
    throw wrapped;
  }
}

async function assetDiscoveryContentCall(tabId, message) {
  let timer;
  try {
    const response = await Promise.race([
      browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("browser asset discovery content RPC timed out");
          error.code = "BROWSER_ASSET_TIMEOUT";
          error.reason = "content_rpc_timeout";
          reject(error);
        }, ASSET_DISCOVERY_CONTENT_RPC_TIMEOUT_MS);
      }),
    ]);
    if (!response?.ok) {
      const error = new Error(String(response?.error?.message || "browser asset discovery failed"));
      error.code = response?.error?.code || "BROWSER_ASSET_FETCH_FAILED";
      error.reason = response?.error?.reason;
      throw error;
    }
    return response.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanupAssetV1Registry() {
  const current = Date.now();
  for (const [ref, entry] of assetV1Refs) {
    if (entry.expires_at <= current) assetV1Refs.delete(ref);
  }
}

async function assetDiscoverV1(params) {
  cleanupAssetV1Registry();
  const contextId = String(params.context_id || "");
  const tabId = tabIdFromContext(contextId);
  const ping = await ensureAssetDiscoveryContent(tabId);
  const discovered = await assetDiscoveryContentCall(tabId, {
    type: "zamery_browser_firefox_asset_discover_v1",
  });
  if (discovered?.document_id !== ping.document_id) {
    const error = new Error("asset discovery document identity changed during discovery");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "document_identity_mismatch";
    throw error;
  }
  const requestedLimit = Number(params.limit);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(100, requestedLimit)
    : 100;
  const snapshotId = crypto.randomUUID();
  const sourceAssets = Array.isArray(discovered?.assets) ? discovered.assets.slice(0, limit) : [];
  const assets = sourceAssets.map((asset) => {
    const publicRef = `basset_v1_${crypto.randomUUID()}`;
    assetV1Refs.set(publicRef, {
      browser_instance_id: browserInstanceId,
      context_id: contextId,
      tab_id: tabId,
      document_id: ping.document_id,
      content_asset_ref: asset.asset_ref,
      expires_at: Number(asset.expires_at) || Date.now() + ASSET_V1_REGISTRY_TTL_MS,
    });
    while (assetV1Refs.size > ASSET_V1_MAX_REFS) assetV1Refs.delete(assetV1Refs.keys().next().value);
    const elementRef = asset.element_node_id ? encodeRef({
      b: browserInstanceId,
      c: contextId,
      d: ping.document_id,
      f: 0,
      s: snapshotId,
      n: asset.element_node_id,
    }) : undefined;
    const containerRef = asset.container_node_id ? encodeRef({
      b: browserInstanceId,
      c: contextId,
      d: ping.document_id,
      f: 0,
      s: snapshotId,
      n: asset.container_node_id,
    }) : undefined;
    return {
      asset_ref: publicRef,
      media_kind: asset.media_kind,
      safe_label: asset.safe_label,
      document_order: asset.document_order,
      rendered: asset.rendered === true,
      intrinsic_width: asset.intrinsic_width,
      intrinsic_height: asset.intrinsic_height,
      representation: { role: asset?.representation?.role || "unknown" },
      discovered_at: asset.discovered_at,
      expires_at: asset.expires_at,
      ...(elementRef ? { element_ref: elementRef } : {}),
      ...(containerRef ? { container_ref: containerRef } : {}),
    };
  });
  return {
    schema: "zamery-browser-assets-v1/1",
    browser_instance_id: browserInstanceId,
    context_id: contextId,
    document_id: ping.document_id,
    frame_identity: "top",
    snapshot_id: snapshotId,
    assets,
  };
}

async function assetCapabilitiesV1(params) {
  const contextId = String(params.context_id || "");
  const tabId = tabIdFromContext(contextId);
  try {
    const ping = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
    return {
      discover: ping?.asset_discovery_v1_ready
        ? { state: "ready" }
        : { state: "unavailable", reason: "asset_discovery_helper_requires_reload" },
      read: ping?.asset_transfer_v1_ready
        ? { state: "ready" }
        : { state: "unavailable", reason: "asset_transfer_helper_requires_reload" },
    };
  } catch {
    return {
      discover: { state: "unavailable", reason: "content_unavailable" },
      read: { state: "unavailable", reason: "content_unavailable" },
    };
  }
}

async function ensureAssetTransferContent(tabId) {
  let ping;
  try {
    ping = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
  } catch {
    ping = null;
  }
  if (ping?.asset_transfer_v1_ready) return ping;
  if (ping) {
    const error = new Error("browser asset transfer helper is not loaded in the current document");
    error.code = "BROWSER_ASSET_FETCH_FAILED";
    error.reason = "asset_transfer_helper_requires_reload";
    throw error;
  }
  try {
    await browser.tabs.executeScript(tabId, {
      file: "asset-discovery-v1.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    await browser.tabs.executeScript(tabId, {
      file: "asset-transfer-v1.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    await browser.tabs.executeScript(tabId, {
      file: "content.js",
      frameId: 0,
      allFrames: false,
      runAt: "document_idle",
    });
    const nextPing = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
    if (nextPing?.asset_transfer_v1_ready) return nextPing;
    throw new Error("asset transfer helper did not initialize");
  } catch (error) {
    const wrapped = new Error("browser asset transfer content is unavailable");
    wrapped.code = "BROWSER_ASSET_FETCH_FAILED";
    wrapped.reason = "asset_transfer_content_unavailable";
    throw wrapped;
  }
}

async function assetTransferContentCall(tabId, message) {
  let timer;
  try {
    const response = await Promise.race([
      browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("browser asset transfer content RPC timed out");
          error.code = "BROWSER_ASSET_TIMEOUT";
          error.reason = "content_rpc_timeout";
          reject(error);
        }, ASSET_TRANSFER_CONTENT_RPC_TIMEOUT_MS);
      }),
    ]);
    if (!response?.ok) {
      const error = new Error(String(response?.error?.message || "browser asset transfer failed"));
      error.code = response?.error?.code || "BROWSER_ASSET_FETCH_FAILED";
      error.reason = response?.error?.reason;
      throw error;
    }
    return response.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanupAssetV1Registries() {
  const current = Date.now();
  for (const [ref, entry] of assetV1Refs) {
    if (entry.expires_at <= current) assetV1Refs.delete(ref);
  }
  for (const [handle, transfer] of assetV1Transfers) {
    if (transfer.expires_at > current) continue;
    assetV1Transfers.delete(handle);
    void browser.tabs.sendMessage(
      transfer.tab_id,
      { type: "zamery_browser_firefox_asset_close_v1", asset_handle: transfer.content_asset_handle, reason: "timeout" },
      { frameId: 0 },
    ).catch(() => undefined);
  }
}

async function withAssetV1Request(requestId, tabId, run) {
  if (cancelledRequests.has(requestId)) {
    cancelledRequests.delete(requestId);
    const error = new Error("browser asset request cancelled before execution");
    error.code = "BROWSER_ASSET_ABORTED";
    error.reason = "cancelled_before_start";
    throw error;
  }
  requestPhases.set(requestId, "started");
  assetV1RequestContexts.set(requestId, { tab_id: tabId });
  try {
    return await run();
  } finally {
    assetV1RequestContexts.delete(requestId);
    requestPhases.delete(requestId);
    cancelledRequests.delete(requestId);
  }
}

async function assetOpenV1(params, requestId) {
  cleanupAssetV1Registries();
  const publicRef = String(params.asset_ref || "");
  const asset = assetV1Refs.get(publicRef);
  if (!asset) {
    const error = new Error("browser asset ref is unknown or expired");
    error.code = "BROWSER_ASSET_REF_UNKNOWN";
    error.reason = "unknown_or_expired";
    throw error;
  }
  const requestedContextId = String(params.context_id || "");
  if (asset.browser_instance_id !== browserInstanceId || (requestedContextId && requestedContextId !== asset.context_id)) {
    const error = new Error("browser asset binding changed");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "browser_or_context_changed";
    throw error;
  }
  const ping = await ensureAssetTransferContent(asset.tab_id);
  if (ping?.document_id !== asset.document_id) {
    const error = new Error("browser document changed");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "document_changed";
    throw error;
  }
  if (assetV1Transfers.size >= ASSET_V1_MAX_ACTIVE_TRANSFERS) {
    const error = new Error("browser asset transfer limit reached");
    error.code = "BROWSER_ASSET_TRANSFER_PROTOCOL";
    error.reason = "active_transfer_limit_reached";
    throw error;
  }
  return withAssetV1Request(requestId, asset.tab_id, async () => {
    const opened = await assetTransferContentCall(asset.tab_id, {
      type: "zamery_browser_firefox_asset_open_v1",
      asset_ref: asset.content_asset_ref,
      expected_document_id: asset.document_id,
      max_asset_bytes: params.max_bytes,
      request_id: requestId,
    });
    const publicHandle = `bhandle_v1_${crypto.randomUUID()}`;
    const publicTransferId = `btransfer_v1_${crypto.randomUUID()}`;
    assetV1Transfers.set(publicHandle, {
      browser_instance_id: browserInstanceId,
      context_id: asset.context_id,
      tab_id: asset.tab_id,
      document_id: asset.document_id,
      content_asset_handle: opened.asset_handle,
      content_transfer_id: opened.transfer_id,
      public_transfer_id: publicTransferId,
      expires_at: Date.now() + ASSET_V1_TRANSFER_TTL_MS,
    });
    const { asset_handle: _internalHandle, transfer_id: _internalTransferId, ...safe } = opened;
    return { ...safe, asset_handle: publicHandle, transfer_id: publicTransferId };
  });
}

async function assetReadChunkV1(params, requestId) {
  cleanupAssetV1Registries();
  const publicHandle = String(params.asset_handle || "");
  const transfer = assetV1Transfers.get(publicHandle);
  if (!transfer) {
    const error = new Error("browser asset handle is unknown or expired");
    error.code = "BROWSER_ASSET_TRANSFER_PROTOCOL";
    error.reason = "asset_handle_unknown_or_expired";
    throw error;
  }
  const ping = await ensureAssetTransferContent(transfer.tab_id);
  if (ping?.document_id !== transfer.document_id) {
    assetV1Transfers.delete(publicHandle);
    const error = new Error("browser document changed during asset transfer");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "document_changed";
    throw error;
  }
  return withAssetV1Request(requestId, transfer.tab_id, async () => {
    const chunk = await assetTransferContentCall(transfer.tab_id, {
      type: "zamery_browser_firefox_asset_read_chunk_v1",
      asset_handle: transfer.content_asset_handle,
      sequence: params.sequence,
      offset: params.offset,
      max_raw_bytes: params.max_raw_bytes,
      request_id: requestId,
    });
    if (chunk.transfer_id !== transfer.content_transfer_id) {
      assetV1Transfers.delete(publicHandle);
      const error = new Error("browser asset transfer identity changed");
      error.code = "BROWSER_ASSET_TRANSFER_PROTOCOL";
      error.reason = "content_transfer_id_changed";
      throw error;
    }
    transfer.expires_at = Date.now() + ASSET_V1_TRANSFER_TTL_MS;
    return { ...chunk, transfer_id: transfer.public_transfer_id };
  });
}

async function assetCloseV1(params, requestId) {
  cleanupAssetV1Registries();
  const publicHandle = String(params.asset_handle || "");
  const transfer = assetV1Transfers.get(publicHandle);
  if (!transfer) return { closed: true };
  assetV1Transfers.delete(publicHandle);
  return withAssetV1Request(requestId, transfer.tab_id, async () => {
    await assetTransferContentCall(transfer.tab_id, {
      type: "zamery_browser_firefox_asset_close_v1",
      asset_handle: transfer.content_asset_handle,
      reason: params.reason,
      request_id: requestId,
    });
    return { closed: true };
  });
}

async function teardownAssetV1Transfers(reason = "teardown") {
  const tabIds = new Set();
  for (const transfer of assetV1Transfers.values()) tabIds.add(transfer.tab_id);
  assetV1Transfers.clear();
  assetV1RequestContexts.clear();
  await Promise.all(Array.from(tabIds, (tabId) => browser.tabs.sendMessage(
    tabId,
    { type: "zamery_browser_firefox_asset_teardown_v1", reason },
    { frameId: 0 },
  ).catch(() => undefined)));
}

function requireA1DevelopmentCompanion() {
  if (browser.runtime.id === A1_DEVELOPMENT_EXTENSION_ID) return;
  const error = new Error("A1 browser asset experiment is development-companion only");
  error.code = "BROWSER_ASSET_EXPERIMENT_UNAVAILABLE";
  error.reason = "production_companion_does_not_advertise_a1_asset_probe";
  throw error;
}

async function ensureA1Content(tabId) {
  requireA1DevelopmentCompanion();
  try {
    const ping = await browser.tabs.sendMessage(
      tabId,
      { type: "zamery_browser_firefox_ping" },
      { frameId: 0 },
    );
    if (ping?.a1_asset_experiment_ready) return ping;
    const error = new Error("A1 asset helper is not loaded in the current document");
    error.code = "BROWSER_ASSET_EXPERIMENT_UNAVAILABLE";
    error.reason = "development_companion_or_document_requires_reload";
    throw error;
  } catch (firstError) {
    if (firstError?.code === "BROWSER_ASSET_EXPERIMENT_UNAVAILABLE") throw firstError;
    try {
      await browser.tabs.executeScript(tabId, {
        file: "asset-a1-experimental.js",
        frameId: 0,
        allFrames: false,
        runAt: "document_idle",
      });
      await browser.tabs.executeScript(tabId, {
        file: "content.js",
        frameId: 0,
        allFrames: false,
        runAt: "document_idle",
      });
      const ping = await browser.tabs.sendMessage(
        tabId,
        { type: "zamery_browser_firefox_ping" },
        { frameId: 0 },
      );
      if (ping?.a1_asset_experiment_ready) return ping;
      throw new Error("A1 asset helper did not initialize");
    } catch (error) {
      const wrapped = new Error("A1 browser asset content probe is unavailable");
      wrapped.code = "BROWSER_ASSET_EXPERIMENT_UNAVAILABLE";
      wrapped.reason = "content_script_injection_blocked_or_helper_unavailable";
      throw wrapped;
    }
  }
}

function cleanupA1Registries() {
  const current = Date.now();
  for (const [ref, entry] of a1AssetRefs) {
    if (entry.expires_at <= current) a1AssetRefs.delete(ref);
  }
  for (const [handle, entry] of a1Transfers) {
    if (entry.expires_at <= current) a1Transfers.delete(handle);
  }
}

function a1ContentError(response) {
  const error = new Error(String(response?.error?.message || "A1 browser asset operation failed"));
  error.code = response?.error?.code || "BROWSER_ASSET_FETCH_FAILED";
  error.reason = response?.error?.reason;
  return error;
}

async function a1ContentCall(tabId, message) {
  let timer;
  try {
    const response = await Promise.race([
      browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("A1 browser asset content RPC timed out");
          error.code = "BROWSER_ASSET_TIMEOUT";
          error.reason = "content_rpc_timeout";
          reject(error);
        }, A1_CONTENT_RPC_TIMEOUT_MS);
      }),
    ]);
    if (!response?.ok) throw a1ContentError(response);
    return response.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withA1Request(requestId, tabId, run) {
  if (cancelledRequests.has(requestId)) {
    cancelledRequests.delete(requestId);
    const error = new Error("browser asset request cancelled before execution");
    error.code = "BROWSER_REQUEST_CANCELLED";
    error.outcome = "not_started";
    throw error;
  }
  requestPhases.set(requestId, "started");
  a1RequestContexts.set(requestId, { tab_id: tabId });
  try {
    return await run();
  } finally {
    a1RequestContexts.delete(requestId);
    requestPhases.delete(requestId);
    cancelledRequests.delete(requestId);
  }
}

async function a1AssetDiscover(params, requestId) {
  cleanupA1Registries();
  const contextId = String(params.context_id || "");
  const tabId = tabIdFromContext(contextId);
  const ping = await ensureA1Content(tabId);
  return withA1Request(requestId, tabId, async () => {
    const discovered = await a1ContentCall(tabId, {
      type: "zamery_browser_firefox_a1_asset_discover",
      request_id: requestId,
    });
    if (discovered?.document_id !== ping.document_id) {
      const error = new Error("asset discovery document identity does not match the top-frame ping");
      error.code = "BROWSER_ASSET_STALE";
      error.reason = "document_identity_mismatch";
      throw error;
    }
    const assets = Array.isArray(discovered?.assets) ? discovered.assets.map((asset) => {
      const publicRef = `basset_a1_${crypto.randomUUID()}`;
      a1AssetRefs.set(publicRef, {
        browser_instance_id: browserInstanceId,
        context_id: contextId,
        tab_id: tabId,
        document_id: ping.document_id,
        content_asset_ref: asset.asset_ref,
        expires_at: Date.now() + A1_REGISTRY_TTL_MS,
      });
      while (a1AssetRefs.size > A1_MAX_ASSET_REFS) a1AssetRefs.delete(a1AssetRefs.keys().next().value);
      const { asset_ref: _internalRef, ...safe } = asset;
      return { ...safe, asset_ref: publicRef };
    }) : [];
    return {
      schema: "zamery-browser-assets-a1-experimental/1",
      browser_instance_id: browserInstanceId,
      context_id: contextId,
      document_id: ping.document_id,
      frame_identity: "top",
      assets,
    };
  });
}

async function a1AssetOpen(params, requestId) {
  cleanupA1Registries();
  const publicRef = String(params.asset_ref || "");
  const asset = a1AssetRefs.get(publicRef);
  if (!asset) {
    const error = new Error("browser asset ref is unknown or expired");
    error.code = "ASSET_REF_UNKNOWN";
    throw error;
  }
  if (asset.browser_instance_id !== browserInstanceId) {
    const error = new Error("browser instance changed");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "browser_instance_changed";
    throw error;
  }
  const ping = await ensureA1Content(asset.tab_id);
  if (ping?.document_id !== asset.document_id) {
    const error = new Error("browser document changed");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "document_changed";
    throw error;
  }
  if (a1Transfers.size >= A1_MAX_ACTIVE_TRANSFERS) {
    const error = new Error("A1 browser asset transfer limit reached");
    error.code = "BROWSER_ASSET_TRANSFER_LIMIT";
    error.reason = "active_transfer_limit_reached";
    throw error;
  }
  return withA1Request(requestId, asset.tab_id, async () => {
    const opened = await a1ContentCall(asset.tab_id, {
      type: "zamery_browser_firefox_a1_asset_open",
      asset_ref: asset.content_asset_ref,
      expected_document_id: asset.document_id,
      max_asset_bytes: params.max_asset_bytes,
      request_id: requestId,
    });
    const publicHandle = `bhandle_a1_${crypto.randomUUID()}`;
    const publicTransferId = `btransfer_a1_${crypto.randomUUID()}`;
    a1Transfers.set(publicHandle, {
      browser_instance_id: browserInstanceId,
      context_id: asset.context_id,
      tab_id: asset.tab_id,
      document_id: asset.document_id,
      content_asset_handle: opened.asset_handle,
      content_transfer_id: opened.transfer_id,
      public_transfer_id: publicTransferId,
      expires_at: Date.now() + A1_REGISTRY_TTL_MS,
    });
    const { asset_handle: _internalHandle, transfer_id: _internalTransferId, ...safe } = opened;
    return {
      ...safe,
      asset_handle: publicHandle,
      transfer_id: publicTransferId,
      frame_identity: "top",
    };
  });
}

async function a1AssetReadChunk(params, requestId) {
  cleanupA1Registries();
  const publicHandle = String(params.asset_handle || "");
  const transfer = a1Transfers.get(publicHandle);
  if (!transfer) {
    const error = new Error("asset handle is unknown or expired");
    error.code = "ASSET_HANDLE_UNKNOWN";
    throw error;
  }
  const ping = await ensureA1Content(transfer.tab_id);
  if (ping?.document_id !== transfer.document_id) {
    a1Transfers.delete(publicHandle);
    const error = new Error("browser document changed during asset transfer");
    error.code = "BROWSER_ASSET_STALE";
    error.reason = "document_changed";
    throw error;
  }
  return withA1Request(requestId, transfer.tab_id, async () => {
    const chunk = await a1ContentCall(transfer.tab_id, {
      type: "zamery_browser_firefox_a1_asset_read_chunk",
      asset_handle: transfer.content_asset_handle,
      sequence: params.sequence,
      offset: params.offset,
      max_raw_bytes: params.max_raw_bytes,
      request_id: requestId,
    });
    if (chunk.transfer_id !== transfer.content_transfer_id) {
      a1Transfers.delete(publicHandle);
      const error = new Error("asset transfer identity changed");
      error.code = "ASSET_IMPORT_TRANSFER_PROTOCOL";
      error.reason = "content_transfer_id_changed";
      throw error;
    }
    transfer.expires_at = Date.now() + A1_REGISTRY_TTL_MS;
    return { ...chunk, transfer_id: transfer.public_transfer_id };
  });
}

async function a1AssetClose(params, requestId) {
  cleanupA1Registries();
  const publicHandle = String(params.asset_handle || "");
  const transfer = a1Transfers.get(publicHandle);
  if (!transfer) return { closed: false, reason: "not_found" };
  a1Transfers.delete(publicHandle);
  return withA1Request(requestId, transfer.tab_id, async () => a1ContentCall(transfer.tab_id, {
    type: "zamery_browser_firefox_a1_asset_close",
    asset_handle: transfer.content_asset_handle,
    request_id: requestId,
  }));
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

browser.tabs.onRemoved.addListener((tabId) => {
  ownedTabIds.delete(tabId);
  for (const [ref, asset] of assetV1Refs) {
    if (asset.tab_id === tabId) assetV1Refs.delete(ref);
  }
  for (const [handle, transfer] of assetV1Transfers) {
    if (transfer.tab_id === tabId) assetV1Transfers.delete(handle);
  }
  for (const [requestId, target] of assetV1RequestContexts) {
    if (target.tab_id === tabId) assetV1RequestContexts.delete(requestId);
  }
});
