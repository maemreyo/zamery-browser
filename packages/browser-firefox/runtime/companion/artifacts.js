// Bounded screenshots and the in-memory artifact store. Pixels never travel in a single message: the
// provider pulls them in <= 64 KiB raw chunks with a terminal SHA-256, and every read re-proves authority.

const SHOT_MAX_SIDE = 4096;
const SHOT_MAX_PIXELS = 8_000_000;
const SHOT_MAX_ENCODED_BYTES = 8 * 1024 * 1024;
const SHOT_CHUNK_RAW_BYTES = 64 * 1024;
const SHOT_CAPTURE_TIMEOUT_MS = 20_000;
const OVERLAY_SUPPRESSION_BARRIER_TIMEOUT_MS = 1_000;
const OVERLAY_SUPPRESSION_HARD_EXPIRY_MS = 30_000;
const OVERLAY_RELEASE_MAX_ATTEMPTS = 3;
const SHOT_TTL_MS = 30 * 60 * 1000;
const SHOT_MAX_AUDIENCE_BYTES = 64 * 1024 * 1024;
const SHOT_MAX_ARTIFACTS = 16;

const artifacts = new Map();
let captureInFlight = null;

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function imageDimensions(bytes, mediaType) {
  if (mediaType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mediaType === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xff) { offset += 1; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] };
      if (length < 2) return null;
      offset += 2 + length;
    }
  }
  return null;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  return btoa(binary);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dropAllArtifacts() {
  artifacts.clear();
}

function pruneArtifacts() {
  const now = Date.now();
  for (const [id, artifact] of artifacts) {
    if (artifact.expiresAt <= now || artifact.bindingInstanceId !== binding?.instanceId) artifacts.delete(id);
  }
}

function audienceArtifactBytes(audienceId) {
  let total = 0;
  for (const artifact of artifacts.values()) if (artifact.audienceId === audienceId) total += artifact.bytes.length;
  return total;
}

function shotError(code, reason, message) {
  return newError(code, message || reason, reason);
}

async function overlayContentRpc(tabId, target, message, reason) {
  let timer;
  try {
    return await Promise.race([
      browser.tabs.sendMessage(tabId, message, target),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(shotError("BROWSER_REQUEST_TIMEOUT", reason, "overlay suppression coordination timed out")), OVERLAY_SUPPRESSION_BARRIER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function overlayTarget(ping) {
  return primaryDocumentTarget(ping?.browser_document_id);
}

async function beginOverlaySuppression(tabId, ping) {
  if (!ping?.agent_presence_v1_ready || ping.agent_presence_version !== 1 || !ping.document_id) {
    throw shotError("BROWSER_REQUEST_FAILED", "overlay_suppression_unavailable", "agent presentation suppression is unavailable in this document");
  }
  const issuedAt = Date.now();
  const state = {
    token: `capture_${crypto.randomUUID()}`,
    tabId,
    documentId: ping.document_id,
    browserDocumentId: ping.browser_document_id || null,
    urlHash: urlHash(ping.url),
    target: overlayTarget(ping),
    issuedAt,
    expiresAt: issuedAt + OVERLAY_SUPPRESSION_HARD_EXPIRY_MS,
  };
  try {
    const applied = await overlayContentRpc(tabId, state.target, {
      type: "zamery_browser_firefox_overlay_suppress",
      token: state.token,
      expected_document_id: state.documentId,
      expires_at: state.expiresAt,
    }, "overlay_suppression_timeout");
    if (!applied?.ok || applied.state !== "suppression_applied" || applied.document_id !== state.documentId || applied.suppression_active !== true) {
      throw shotError("BROWSER_REQUEST_FAILED", "overlay_suppression_not_applied");
    }
    const confirmed = await overlayContentRpc(tabId, state.target, {
      type: "zamery_browser_firefox_overlay_confirm_suppression",
      token: state.token,
      expected_document_id: state.documentId,
    }, "overlay_suppression_confirmation_timeout");
    if (!confirmed?.ok || confirmed.state !== "suppression_confirmed" || confirmed.document_id !== state.documentId || confirmed.suppression_active !== true) {
      throw shotError("BROWSER_REQUEST_FAILED", "overlay_suppression_unconfirmed");
    }
    state.paintBarrier = confirmed.paint_barrier || "unknown";
    return state;
  } catch (error) {
    void releaseOverlaySuppression(state);
    throw error;
  }
}

async function releaseOverlaySuppression(state) {
  if (!state?.token || Date.now() >= state.expiresAt) return false;
  for (let attempt = 0; attempt < OVERLAY_RELEASE_MAX_ATTEMPTS && Date.now() < state.expiresAt; attempt += 1) {
    try {
      const released = await overlayContentRpc(state.tabId, state.target, {
        type: "zamery_browser_firefox_overlay_release",
        token: state.token,
        expected_document_id: state.documentId,
      }, "overlay_release_timeout");
      if (released?.ok && released.state === "suppression_released" && released.document_id === state.documentId) return true;
      if (released?.reason === "document_mismatch") return false;
    } catch {}
  }
  return false;
}

function sameCapturedDocument(before, after) {
  return Boolean(
    before?.document_id
    && after?.document_id === before.document_id
    && (!before.browser_document_id || after.browser_document_id === before.browser_document_id)
    && urlHash(after?.url) === urlHash(before?.url),
  );
}

/** Resolve and validate the capture rectangle from explicit input or the page's observed viewport. */
function resolveCaptureRect(params, ping) {
  const viewport = {
    x: Math.max(0, Math.floor(Number(ping?.scroll_x) || 0)),
    y: Math.max(0, Math.floor(Number(ping?.scroll_y) || 0)),
    width: Math.floor(Number(ping?.viewport_width) || 0),
    height: Math.floor(Number(ping?.viewport_height) || 0),
  };
  const raw = params.rect && typeof params.rect === "object" ? params.rect : viewport;
  const rect = { x: Number(raw.x ?? 0), y: Number(raw.y ?? 0), width: Number(raw.width), height: Number(raw.height) };
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || rect.x < 0 || rect.y < 0) throw shotError("INVALID_ARGUMENT", "invalid_rect_origin");
  if (!isPositiveInt(rect.width) || !isPositiveInt(rect.height)) throw shotError("INVALID_ARGUMENT", "invalid_rect_size", "rect width/height must be positive integers");
  if (rect.width > SHOT_MAX_SIDE || rect.height > SHOT_MAX_SIDE) throw shotError("INVALID_ARGUMENT", "rect_side_too_large", `rect sides are limited to ${SHOT_MAX_SIDE} CSS px`);
  return rect;
}

function resolveCaptureScale(params, rect) {
  let scale = params.scale === undefined ? 1 : Number(params.scale);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw shotError("INVALID_ARGUMENT", "invalid_scale", "scale must be in (0, 1]");
  if (params.max_side !== undefined) {
    const maxSide = Number(params.max_side);
    if (!isPositiveInt(maxSide) || maxSide > SHOT_MAX_SIDE) throw shotError("INVALID_ARGUMENT", "invalid_max_side");
    scale = Math.min(scale, maxSide / Math.max(rect.width, rect.height));
  }
  // Firefox's own default is devicePixelRatio; the scale is always explicit here so output size is predictable.
  const outWidth = Math.max(1, Math.ceil(rect.width * scale));
  const outHeight = Math.max(1, Math.ceil(rect.height * scale));
  if (outWidth > SHOT_MAX_SIDE || outHeight > SHOT_MAX_SIDE || outWidth * outHeight > SHOT_MAX_PIXELS) {
    throw shotError("INVALID_ARGUMENT", "pixel_budget_exceeded", `output would be ${outWidth}x${outHeight} px`);
  }
  return { scale, outWidth, outHeight };
}

async function captureScreenshot(params, message) {
  if (typeof browser.tabs.captureTab !== "function") throw shotError("UNSUPPORTED_CAPABILITY", "captureTab_unavailable");
  const audienceId = requestAudienceId(message);
  const contextId = String(params.context_id || "");
  const format = params.format === undefined ? "png" : params.format;
  if (format !== "png" && format !== "jpeg") throw shotError("INVALID_ARGUMENT", "invalid_format");
  let quality;
  if (format === "jpeg") {
    quality = params.quality === undefined ? 85 : Number(params.quality);
    if (!Number.isSafeInteger(quality) || quality < 1 || quality > 100) throw shotError("INVALID_ARGUMENT", "invalid_quality");
  }

  const { tabId } = await contextAuthorization(contextId, "capture");
  if (captureInFlight) throw shotError("RESOURCE_BUSY", "capture_in_progress", "another capture is still running");
  const captureSlot = crypto.randomUUID();
  captureInFlight = captureSlot;
  const lineage = lineageNow(audienceId);
  let suppression = null;
  let callerTimedOut = false;
  let hardExpiryTimer = null;
  const releaseSlot = () => {
    if (captureInFlight === captureSlot) captureInFlight = null;
  };
  try {
    pruneArtifacts();
    const before = await ensureContent(tabId).catch(() => null);
    if (!before?.document_id) throw shotError("BROWSER_CONTEXT_UNAVAILABLE", "content_unavailable");
    const rect = resolveCaptureRect(params, before);
    const { scale, outWidth, outHeight } = resolveCaptureScale(params, rect);
    suppression = await beginOverlaySuppression(tabId, before);

    // Suppression coordination creates an authority/document race window. Re-prove the original capture
    // lineage and exact document immediately before calling captureTab; Take over alone is not a claim gate.
    if (!lineageCurrent(lineage)) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "authorization_changed_before_capture");
    const preDispatchAuthorization = await contextAuthorization(contextId, "capture");
    if (preDispatchAuthorization.tabId !== tabId) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "capture_context_rebound");
    const preDispatch = await ensureContent(tabId).catch(() => null);
    if (!sameCapturedDocument(before, preDispatch)) {
      throw newError("BROWSER_DOCUMENT_CHANGED", "the page changed while screenshot suppression was being confirmed", "document_changed_before_capture");
    }
    // ensureContent() itself awaits presentation sync. Re-check the original authority lineage after that
    // final await so revoke/expiry/rebind cannot reach captureTab through the presentation coordination gap.
    if (!lineageCurrent(lineage)) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "authorization_changed_before_capture");
    // Presentation sync may also observe a navigation and mark the tab's origin as pending without changing
    // the binding lineage. Re-evaluate capture access synchronously from the already-fetched tab snapshot so
    // pending-origin/scope changes cannot cross another await before captureTab dispatch.
    contextAuthorizationCurrent(tabId, preDispatchAuthorization.tab, "capture");

    const options = { format, scale, rect };
    if (quality !== undefined) options.quality = quality;
    let timer;
    let underlyingCapture;
    try {
      // Dispatch synchronously after the final checks; deferring through a microtask would reopen a revoke gap.
      underlyingCapture = Promise.resolve(browser.tabs.captureTab(tabId, options));
    } catch (error) {
      underlyingCapture = Promise.reject(error);
    }
    let dataUrl;
    try {
      dataUrl = await Promise.race([
        underlyingCapture,
        new Promise((_, reject) => { timer = setTimeout(() => reject(shotError("BROWSER_REQUEST_TIMEOUT", "capture_timeout", "tab capture did not finish in time")), SHOT_CAPTURE_TIMEOUT_MS); }),
      ]);
    } catch (error) {
      if (error?.reason !== "capture_timeout") throw error;
      callerTimedOut = true;
      const settleLateCapture = () => {
        if (hardExpiryTimer) clearTimeout(hardExpiryTimer);
        void releaseOverlaySuppression(suppression);
        releaseSlot();
      };
      // The late capture result is intentionally ignored forever; it never re-enters artifact publication.
      void underlyingCapture.then(settleLateCapture, settleLateCapture);
      hardExpiryTimer = setTimeout(() => {
        void releaseOverlaySuppression(suppression);
        releaseSlot();
      }, Math.max(0, suppression.expiresAt - Date.now()));
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Authority and page identity may have moved while Firefox rendered. Re-prove both before keeping pixels.
    if (!lineageCurrent(lineage)) throw denial("BROWSER_AUTHORIZATION_REQUIRED", "authorization_changed_during_capture");
    const { tab: after } = await contextAuthorization(contextId, "capture");
    const afterPing = await ensureContent(tabId).catch(() => null);
    if (!sameCapturedDocument(before, afterPing)) {
      throw newError("BROWSER_DOCUMENT_CHANGED", "the page changed while it was being captured", "document_changed_during_capture");
    }
    void after;

    const match = /^data:(image\/(?:png|jpeg));base64,/.exec(typeof dataUrl === "string" ? dataUrl.slice(0, 40) : "");
    if (!match) throw shotError("BROWSER_REQUEST_FAILED", "unexpected_capture_result");
    const mediaType = match[1];
    if (mediaType !== `image/${format}`) throw shotError("BROWSER_REQUEST_FAILED", "unexpected_capture_result", "Firefox returned a different image format than requested");
    const encodedLength = dataUrl.length - match[0].length;
    // Bound before decoding. Firefox has already materialized the string; we refuse to allocate more.
    if (encodedLength > Math.ceil(SHOT_MAX_ENCODED_BYTES * 4 / 3) + 8) throw shotError("ARTIFACT_SIZE_LIMIT", "encoded_image_too_large", "captured image exceeds the 8 MiB limit");
    const bytes = base64ToBytes(dataUrl.slice(match[0].length));
    if (bytes.length === 0 || bytes.length > SHOT_MAX_ENCODED_BYTES) throw shotError("ARTIFACT_SIZE_LIMIT", "encoded_image_too_large", "captured image exceeds the 8 MiB limit");
    const dimensions = imageDimensions(bytes, mediaType);
    if (!dimensions) throw shotError("BROWSER_REQUEST_FAILED", "image_header_unreadable");
    if (dimensions.width > SHOT_MAX_SIDE || dimensions.height > SHOT_MAX_SIDE || dimensions.width * dimensions.height > SHOT_MAX_PIXELS) {
      throw shotError("ARTIFACT_SIZE_LIMIT", "decoded_dimensions_exceed_limit");
    }
    void outWidth;
    void outHeight;

    const now = Date.now();
    if (audienceArtifactBytes(audienceId) + bytes.length > SHOT_MAX_AUDIENCE_BYTES || artifacts.size >= SHOT_MAX_ARTIFACTS) {
      // Oldest first: a fresh capture is worth more than an old one.
      const mine = [...artifacts.entries()].filter(([, artifact]) => artifact.audienceId === audienceId);
      for (const [id] of mine) {
        if (audienceArtifactBytes(audienceId) + bytes.length <= SHOT_MAX_AUDIENCE_BYTES && artifacts.size < SHOT_MAX_ARTIFACTS) break;
        artifacts.delete(id);
      }
    }
    const artifactId = `art_${crypto.randomUUID().replace(/-/g, "")}`;
    const sha256 = await sha256Hex(bytes);
    const artifact = {
      artifactId,
      audienceId,
      bindingInstanceId: binding.instanceId,
      contextId,
      documentId: before.document_id,
      mediaType,
      width: dimensions.width,
      height: dimensions.height,
      byteSize: bytes.length,
      sha256,
      bytes,
      capturedRect: rect,
      appliedScale: scale,
      grantRevision: binding.grantRevision,
      createdAt: now,
      expiresAt: now + SHOT_TTL_MS,
    };
    artifacts.set(artifactId, artifact);
    return { outcome: "completed", ...artifactDescriptor(artifact) };
  } finally {
    if (!callerTimedOut) {
      if (hardExpiryTimer) clearTimeout(hardExpiryTimer);
      if (suppression) await releaseOverlaySuppression(suppression);
      releaseSlot();
    }
  }
}

function artifactDescriptor(artifact) {
  return {
    artifact_id: artifact.artifactId,
    kind: "screenshot",
    media_type: artifact.mediaType,
    width: artifact.width,
    height: artifact.height,
    byte_size: artifact.byteSize,
    sha256: artifact.sha256,
    context_id: artifact.contextId,
    document_id: artifact.documentId,
    captured_rect: artifact.capturedRect,
    applied_scale: artifact.appliedScale,
    grant_revision: artifact.grantRevision,
    binding_token: artifact.bindingInstanceId,
    chunk_raw_bytes: SHOT_CHUNK_RAW_BYTES,
    created_at: artifact.createdAt,
    expires_at: artifact.expiresAt,
  };
}

/** Every read re-proves audience, binding, scope and expiry before a single byte leaves. */
async function liveArtifact(params, message) {
  pruneArtifacts();
  const artifact = artifacts.get(String(params.artifact_id || ""));
  if (!artifact) throw shotError("ARTIFACT_EXPIRED", "artifact_unknown_or_expired");
  if (artifact.audienceId !== requestAudienceId(message) || artifact.bindingInstanceId !== binding?.instanceId) {
    artifacts.delete(artifact.artifactId);
    throw shotError("ARTIFACT_EXPIRED", "artifact_authority_ended");
  }
  await contextAuthorization(artifact.contextId, "capture");
  return artifact;
}

async function readArtifactChunk(params, message) {
  const artifact = await liveArtifact(params, message);
  const sequence = Number(params.sequence);
  const offset = Number(params.offset);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(offset) || offset < 0 || offset > artifact.bytes.length) {
    throw shotError("INVALID_ARGUMENT", "invalid_chunk_position");
  }
  // Deterministic by offset, so repeating the current (sequence, offset) replays the identical chunk.
  if (offset !== sequence * SHOT_CHUNK_RAW_BYTES) throw shotError("INVALID_ARGUMENT", "chunk_sequence_offset_mismatch");
  const end = Math.min(artifact.bytes.length, offset + SHOT_CHUNK_RAW_BYTES);
  const slice = artifact.bytes.subarray(offset, end);
  const eof = end >= artifact.bytes.length;
  return {
    artifact_id: artifact.artifactId,
    sequence,
    offset,
    raw_bytes: slice.length,
    data_base64: bytesToBase64(slice),
    eof,
    ...(eof ? { terminal: { bytes: artifact.bytes.length, sha256: artifact.sha256 } } : {}),
  };
}

function closeArtifact(params, message) {
  const artifact = artifacts.get(String(params.artifact_id || ""));
  if (artifact && artifact.audienceId === requestAudienceId(message)) artifacts.delete(artifact.artifactId);
  return { closed: true };
}

async function executeArtifactRequest(op, params, message) {
  if (op === "screenshot_capture") return { value: await captureScreenshot(params, message) };
  if (op === "artifact_read_chunk") return { value: await readArtifactChunk(params, message) };
  if (op === "artifact_close") return { value: closeArtifact(params, message) };
  return undefined;
}
