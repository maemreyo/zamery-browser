(() => {
  const ASSET_REF_TTL_MS = 5 * 60 * 1000;
  const TRANSFER_TTL_MS = 2 * 60 * 1000;
  const DEFAULT_MAX_ASSET_BYTES = 25 * 1024 * 1024;
  const MAX_RAW_CHUNK_BYTES = 128 * 1024;
  const MAX_DISCOVERED_ASSETS = 100;
  const MAX_ASSET_REFS = 256;
  const MAX_ACTIVE_TRANSFERS = 8;
  const MAX_SELECTED_SOURCE_CHARS = 16 * 1024;

  function safeText(value, limit = 160) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function assetError(code, reason, message = code) {
    const error = new Error(message);
    error.code = code;
    if (reason) error.reason = reason;
    return error;
  }

  function normalizeAssetError(error) {
    const known = typeof error?.code === "string" ? error.code : "BROWSER_ASSET_FETCH_FAILED";
    const safeMessages = {
      ASSET_REF_UNKNOWN: "asset ref is unknown",
      ASSET_REF_EXPIRED: "asset ref expired",
      BROWSER_ASSET_STALE: "browser asset binding is stale",
      BROWSER_ASSET_CROSS_ORIGIN_REFUSED: "browser asset source is cross-origin",
      BROWSER_ASSET_SCHEME_REFUSED: "browser asset source scheme is refused",
      BROWSER_ASSET_FETCH_FAILED: "browser asset fetch failed",
      BROWSER_ASSET_BOUNDED_STREAM_UNAVAILABLE: "bounded browser stream reader is unavailable",
      ASSET_IMPORT_SIZE_LIMIT: "asset exceeds configured size limit",
      ASSET_IMPORT_TRANSFER_PROTOCOL: "asset transfer protocol violation",
      ASSET_IMPORT_ABORTED: "asset transfer aborted",
      ASSET_HANDLE_UNKNOWN: "asset handle is unknown",
      ASSET_HANDLE_EXPIRED: "asset handle expired",
      BROWSER_ASSET_TRANSFER_LIMIT: "browser asset transfer limit reached",
    };
    return {
      code: known,
      message: safeMessages[known] || "browser asset operation failed",
      ...(typeof error?.reason === "string" ? { reason: safeText(error.reason, 120) } : {}),
    };
  }

  function toHex32(value) {
    return value.toString(16).padStart(8, "0");
  }

  class Sha256 {
    constructor() {
      this.h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
      ]);
      this.buffer = new Uint8Array(64);
      this.bufferLength = 0;
      this.bytesHashed = 0;
      this.finished = false;
      this.digestHex = null;
    }

    update(input) {
      if (this.finished) throw new Error("sha256 already finalized");
      const data = input instanceof Uint8Array ? input : new Uint8Array(input);
      let position = 0;
      this.bytesHashed += data.byteLength;
      while (position < data.byteLength) {
        const take = Math.min(data.byteLength - position, 64 - this.bufferLength);
        this.buffer.set(data.subarray(position, position + take), this.bufferLength);
        this.bufferLength += take;
        position += take;
        if (this.bufferLength === 64) {
          this.compress(this.buffer);
          this.bufferLength = 0;
        }
      }
      return this;
    }

    compress(chunk) {
      const k = Sha256.K;
      const w = new Uint32Array(64);
      for (let i = 0; i < 16; i += 1) {
        const j = i * 4;
        w[i] = ((chunk[j] << 24) | (chunk[j + 1] << 16) | (chunk[j + 2] << 8) | chunk[j + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i += 1) {
        const x = w[i - 15];
        const y = w[i - 2];
        const s0 = (Sha256.rotr(x, 7) ^ Sha256.rotr(x, 18) ^ (x >>> 3)) >>> 0;
        const s1 = (Sha256.rotr(y, 17) ^ Sha256.rotr(y, 19) ^ (y >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let [a, b, c, d, e, f, g, h] = this.h;
      for (let i = 0; i < 64; i += 1) {
        const s1 = (Sha256.rotr(e, 6) ^ Sha256.rotr(e, 11) ^ Sha256.rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const t1 = (h + s1 + ch + k[i] + w[i]) >>> 0;
        const s0 = (Sha256.rotr(a, 2) ^ Sha256.rotr(a, 13) ^ Sha256.rotr(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const t2 = (s0 + maj) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }

      this.h[0] = (this.h[0] + a) >>> 0;
      this.h[1] = (this.h[1] + b) >>> 0;
      this.h[2] = (this.h[2] + c) >>> 0;
      this.h[3] = (this.h[3] + d) >>> 0;
      this.h[4] = (this.h[4] + e) >>> 0;
      this.h[5] = (this.h[5] + f) >>> 0;
      this.h[6] = (this.h[6] + g) >>> 0;
      this.h[7] = (this.h[7] + h) >>> 0;
    }

    hex() {
      if (this.digestHex) return this.digestHex;
      if (this.finished) throw new Error("sha256 finalized without digest");
      const bitLength = this.bytesHashed * 8;
      const tailLength = this.bufferLength;
      const paddedLength = tailLength < 56 ? 64 : 128;
      const padded = new Uint8Array(paddedLength);
      padded.set(this.buffer.subarray(0, tailLength), 0);
      padded[tailLength] = 0x80;
      const high = Math.floor(bitLength / 0x100000000);
      const low = bitLength >>> 0;
      const end = padded.length;
      padded[end - 8] = (high >>> 24) & 0xff;
      padded[end - 7] = (high >>> 16) & 0xff;
      padded[end - 6] = (high >>> 8) & 0xff;
      padded[end - 5] = high & 0xff;
      padded[end - 4] = (low >>> 24) & 0xff;
      padded[end - 3] = (low >>> 16) & 0xff;
      padded[end - 2] = (low >>> 8) & 0xff;
      padded[end - 1] = low & 0xff;
      for (let offset = 0; offset < padded.length; offset += 64) {
        this.compress(padded.subarray(offset, offset + 64));
      }
      this.finished = true;
      this.digestHex = Array.from(this.h, toHex32).join("");
      return this.digestHex;
    }

    static rotr(value, bits) {
      return ((value >>> bits) | (value << (32 - bits))) >>> 0;
    }
  }

  Sha256.K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function bytesToBase64(bytes, btoaFn) {
    let binary = "";
    const stride = 0x8000;
    for (let offset = 0; offset < bytes.byteLength; offset += stride) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + stride)));
    }
    return btoaFn(binary);
  }

  function sourceForImage(image, baseHref) {
    const selected = String(image.currentSrc || image.src || "").trim();
    if (!selected || selected.length > MAX_SELECTED_SOURCE_CHARS) return null;
    let parsed;
    try {
      parsed = new URL(selected, baseHref);
    } catch {
      return null;
    }
    return { url: parsed.href, origin: parsed.origin, protocol: parsed.protocol };
  }

  function createContentAssetRuntime(environment = {}) {
    const doc = environment.document || globalThis.document;
    const loc = environment.location || globalThis.location;
    const fetchFn = environment.fetch || globalThis.fetch?.bind(globalThis);
    const cryptoApi = environment.crypto || globalThis.crypto;
    const btoaFn = environment.btoa || globalThis.btoa?.bind(globalThis);
    const now = environment.now || (() => Date.now());
    const documentId = String(environment.documentId || cryptoApi?.randomUUID?.() || "");
    if (!doc || !loc || typeof fetchFn !== "function" || !cryptoApi?.randomUUID || typeof btoaFn !== "function") {
      throw new Error("A1 asset runtime environment is incomplete");
    }

    const assetRefs = new Map();
    const transfers = new Map();
    const activeRequests = new Map();

    function cleanup() {
      const current = now();
      for (const [ref, entry] of assetRefs) {
        if (entry.expiresAt <= current) assetRefs.delete(ref);
      }
      for (const [handle, transfer] of transfers) {
        if (transfer.expiresAt <= current) {
          try { transfer.controller.abort(); } catch {}
          try { void transfer.reader.cancel("expired"); } catch {}
          transfers.delete(handle);
        }
      }
    }

    function discoverAssets() {
      cleanup();
      const images = Array.from(doc.querySelectorAll("img"));
      const assets = [];
      let order = 0;
      for (const image of images) {
        if (assets.length >= MAX_DISCOVERED_ASSETS) break;
        if (!image?.isConnected || !doc.contains(image)) continue;
        const source = sourceForImage(image, loc.href);
        if (!source) continue;
        const assetRef = `a1asset_${cryptoApi.randomUUID()}`;
        const container = image.closest?.("[data-message-author-role], article, [role='article']") || null;
        assetRefs.set(assetRef, {
          assetRef,
          element: image,
          selectedSource: source.url,
          sourceOrigin: source.origin,
          discoveredAt: now(),
          expiresAt: now() + ASSET_REF_TTL_MS,
        });
        while (assetRefs.size > MAX_ASSET_REFS) assetRefs.delete(assetRefs.keys().next().value);
        assets.push({
          asset_ref: assetRef,
          safe_label: safeText(image.getAttribute?.("alt") || image.getAttribute?.("aria-label") || "image"),
          document_order: order++,
          rendered: Boolean(image.complete && Number(image.naturalWidth) > 0 && Number(image.naturalHeight) > 0),
          intrinsic_width: Number(image.naturalWidth) || undefined,
          intrinsic_height: Number(image.naturalHeight) || undefined,
          representation: { role: "unknown" },
          source_origin: source.origin,
          semantic_container: container ? {
            role: safeText(container.getAttribute?.("data-message-author-role") || container.getAttribute?.("role") || container.tagName || "container", 80),
            label: safeText(container.getAttribute?.("aria-label") || "", 120) || undefined,
          } : undefined,
        });
      }
      return { document_id: documentId, assets };
    }

    function resolveAsset(assetRef) {
      cleanup();
      const entry = assetRefs.get(String(assetRef || ""));
      if (!entry) throw assetError("ASSET_REF_UNKNOWN", "unknown_or_expired");
      if (entry.expiresAt <= now()) {
        assetRefs.delete(entry.assetRef);
        throw assetError("ASSET_REF_EXPIRED", "ttl_elapsed");
      }
      const element = entry.element;
      if (!element?.isConnected || !doc.contains(element)) {
        throw assetError("BROWSER_ASSET_STALE", "source_element_disconnected");
      }
      const current = sourceForImage(element, loc.href);
      if (!current || current.url !== entry.selectedSource) {
        throw assetError("BROWSER_ASSET_STALE", "selected_source_changed");
      }
      if (current.protocol !== "https:" && current.protocol !== "http:") {
        throw assetError("BROWSER_ASSET_SCHEME_REFUSED", "scheme_not_http_or_https");
      }
      if (current.origin !== loc.origin) {
        throw assetError("BROWSER_ASSET_CROSS_ORIGIN_REFUSED", "source_origin_differs_from_document");
      }
      return entry;
    }

    async function openAsset(assetRef, options = {}) {
      if (String(options.expected_document_id || "") !== documentId) {
        throw assetError("BROWSER_ASSET_STALE", "document_changed");
      }
      const entry = resolveAsset(assetRef);
      const maxAssetBytes = Number(options.max_asset_bytes ?? DEFAULT_MAX_ASSET_BYTES);
      if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes <= 0) {
        throw assetError("ASSET_IMPORT_TRANSFER_PROTOCOL", "invalid_max_asset_bytes");
      }
      const requestId = safeText(options.request_id || cryptoApi.randomUUID(), 200);
      const controller = new AbortController();
      activeRequests.set(requestId, { controller, handle: null });
      let response;
      try {
        response = await fetchFn(entry.selectedSource, {
          credentials: "include",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (error) {
        activeRequests.delete(requestId);
        if (controller.signal.aborted) throw assetError("ASSET_IMPORT_ABORTED", "fetch_aborted");
        throw assetError("BROWSER_ASSET_FETCH_FAILED", "redirect_or_network_failure");
      }
      if (!response?.ok) {
        activeRequests.delete(requestId);
        controller.abort();
        throw assetError("BROWSER_ASSET_FETCH_FAILED", "non_success_response");
      }
      const contentLengthHeader = response.headers?.get?.("content-length") || null;
      const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > maxAssetBytes) {
        activeRequests.delete(requestId);
        controller.abort();
        throw assetError("ASSET_IMPORT_SIZE_LIMIT", "content_length_exceeds_limit");
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        activeRequests.delete(requestId);
        controller.abort();
        throw assetError("BROWSER_ASSET_BOUNDED_STREAM_UNAVAILABLE", "response_body_unavailable");
      }
      let reader;
      try {
        reader = response.body.getReader({ mode: "byob" });
      } catch {
        activeRequests.delete(requestId);
        controller.abort();
        throw assetError("BROWSER_ASSET_BOUNDED_STREAM_UNAVAILABLE", "byob_reader_unavailable");
      }
      if (transfers.size >= MAX_ACTIVE_TRANSFERS) {
        activeRequests.delete(requestId);
        controller.abort();
        try { await reader.cancel("transfer_limit"); } catch {}
        throw assetError("BROWSER_ASSET_TRANSFER_LIMIT", "active_transfer_limit_reached");
      }
      const assetHandle = `a1handle_${cryptoApi.randomUUID()}`;
      const transferId = `a1transfer_${cryptoApi.randomUUID()}`;
      const transfer = {
        assetHandle,
        transferId,
        reader,
        controller,
        hasher: new Sha256(),
        bytes: 0,
        nextSequence: 0,
        nextOffset: 0,
        replay: null,
        terminal: false,
        maxAssetBytes,
        createdAt: now(),
        expiresAt: now() + TRANSFER_TTL_MS,
      };
      transfers.set(assetHandle, transfer);
      activeRequests.set(requestId, { controller, handle: assetHandle });
      activeRequests.delete(requestId);
      const mimeType = safeText(response.headers?.get?.("content-type") || "application/octet-stream", 120).split(";", 1)[0] || "application/octet-stream";
      return {
        transfer_id: transferId,
        asset_handle: assetHandle,
        mime_type: mimeType,
        content_length: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null,
        next_sequence: 0,
        next_offset: 0,
        representation_binding: "source-revalidated",
        execution_context: "content-script",
        request_api: "fetch",
        credential_mode: "include",
        redirect_mode: "error",
        reader_mode: "byob",
        max_raw_chunk_bytes: MAX_RAW_CHUNK_BYTES,
      };
    }

    function resolveTransfer(handle) {
      cleanup();
      const transfer = transfers.get(String(handle || ""));
      if (!transfer) throw assetError("ASSET_HANDLE_UNKNOWN", "unknown_or_expired");
      if (transfer.expiresAt <= now()) {
        transfers.delete(transfer.assetHandle);
        try { transfer.controller.abort(); } catch {}
        throw assetError("ASSET_HANDLE_EXPIRED", "ttl_elapsed");
      }
      return transfer;
    }

    async function readChunk(handle, request = {}) {
      const transfer = resolveTransfer(handle);
      const sequence = Number(request.sequence);
      const offset = Number(request.offset);
      const maxRawBytes = Number(request.max_raw_bytes);
      const requestId = safeText(request.request_id || cryptoApi.randomUUID(), 200);

      if (transfer.replay && sequence === transfer.replay.sequence && offset === transfer.replay.offset) {
        return transfer.replay;
      }
      if (transfer.terminal) {
        throw assetError("ASSET_IMPORT_TRANSFER_PROTOCOL", "read_after_terminal");
      }
      if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(offset)
        || sequence !== transfer.nextSequence || offset !== transfer.nextOffset) {
        await closeTransfer(transfer, "protocol_position_mismatch");
        throw assetError("ASSET_IMPORT_TRANSFER_PROTOCOL", "sequence_or_offset_mismatch");
      }
      if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes <= 0 || maxRawBytes > MAX_RAW_CHUNK_BYTES) {
        await closeTransfer(transfer, "invalid_chunk_budget");
        throw assetError("ASSET_IMPORT_TRANSFER_PROTOCOL", "invalid_max_raw_bytes");
      }

      transfer.replay = null;
      activeRequests.set(requestId, { controller: transfer.controller, handle: transfer.assetHandle });
      let value;
      let done = false;
      try {
        for (let emptyReads = 0; emptyReads < 16; emptyReads += 1) {
          const result = await transfer.reader.read(new Uint8Array(maxRawBytes));
          value = result.value;
          done = Boolean(result.done);
          if (done || (value && value.byteLength > 0)) break;
        }
      } catch {
        activeRequests.delete(requestId);
        if (transfer.controller.signal.aborted) {
          transfers.delete(transfer.assetHandle);
          throw assetError("ASSET_IMPORT_ABORTED", "stream_aborted");
        }
        transfers.delete(transfer.assetHandle);
        throw assetError("BROWSER_ASSET_FETCH_FAILED", "stream_read_failed");
      }
      activeRequests.delete(requestId);
      const bytes = value && value.byteLength > 0
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(0);
      if (!done && bytes.byteLength === 0) {
        await closeTransfer(transfer, "empty_read_limit");
        throw assetError("ASSET_IMPORT_TRANSFER_PROTOCOL", "repeated_empty_stream_reads");
      }
      if (transfer.bytes + bytes.byteLength > transfer.maxAssetBytes) {
        await closeTransfer(transfer, "stream_limit_exceeded");
        throw assetError("ASSET_IMPORT_SIZE_LIMIT", "streaming_bytes_exceed_limit");
      }

      transfer.hasher.update(bytes);
      transfer.bytes += bytes.byteLength;
      const response = {
        transfer_id: transfer.transferId,
        sequence,
        offset,
        raw_bytes: bytes.byteLength,
        data_base64: bytesToBase64(bytes, btoaFn),
        eof: done,
        ...(done ? {
          terminal: {
            acquisition_bytes: transfer.bytes,
            acquisition_sha256: transfer.hasher.hex(),
          },
        } : {}),
      };
      transfer.replay = response;
      transfer.nextSequence = sequence + 1;
      transfer.nextOffset = offset + bytes.byteLength;
      transfer.terminal = done;
      transfer.expiresAt = now() + TRANSFER_TTL_MS;
      return response;
    }

    async function closeTransfer(transfer, reason = "closed") {
      transfers.delete(transfer.assetHandle);
      try { transfer.controller.abort(); } catch {}
      try { await transfer.reader.cancel(reason); } catch {}
    }

    async function closeAsset(handle) {
      const transfer = transfers.get(String(handle || ""));
      if (!transfer) return { closed: false, reason: "not_found" };
      await closeTransfer(transfer, "explicit_close");
      return { closed: true };
    }

    async function cancelRequest(requestId) {
      const active = activeRequests.get(String(requestId || ""));
      if (!active) return { cancelled: false, reason: "not_in_flight" };
      try { active.controller.abort(); } catch {}
      activeRequests.delete(String(requestId || ""));
      if (active.handle) {
        const transfer = transfers.get(active.handle);
        if (transfer) await closeTransfer(transfer, "request_cancelled");
      }
      return { cancelled: true };
    }

    return {
      discoverAssets,
      openAsset,
      readChunk,
      closeAsset,
      cancelRequest,
      limits: {
        max_raw_chunk_bytes: MAX_RAW_CHUNK_BYTES,
        default_max_asset_bytes: DEFAULT_MAX_ASSET_BYTES,
      },
    };
  }

  globalThis.ZameryAssetA1Experimental = Object.freeze({
    createContentAssetRuntime,
    createSha256ForTest: () => new Sha256(),
    constants: Object.freeze({
      ASSET_REF_TTL_MS,
      TRANSFER_TTL_MS,
      DEFAULT_MAX_ASSET_BYTES,
      MAX_RAW_CHUNK_BYTES,
      MAX_DISCOVERED_ASSETS,
      MAX_ASSET_REFS,
      MAX_ACTIVE_TRANSFERS,
      MAX_SELECTED_SOURCE_CHARS,
    }),
    normalizeAssetError,
  });
})();
