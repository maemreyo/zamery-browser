(() => {
  const TRANSFER_TTL_MS = 2 * 60 * 1000;
  const DEFAULT_MAX_ASSET_BYTES = 25 * 1024 * 1024;
  const MAX_RAW_CHUNK_BYTES = 128 * 1024;
  const MAX_ACTIVE_TRANSFERS = 8;
  const IO_TIMEOUT_MS = 10 * 1000;

  const safeText = (value, limit = 160) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  function assetError(code, reason) {
    const error = new Error(code);
    error.code = code;
    if (reason) error.reason = reason;
    return error;
  }
  function normalizeAssetError(error) {
    const code = typeof error?.code === "string" ? error.code : "BROWSER_ASSET_FETCH_FAILED";
    return {
      code,
      message: "browser asset transfer failed",
      ...(typeof error?.reason === "string" ? { reason: safeText(error.reason, 120) } : {}),
    };
  }

  const rotr = (value, bits) => ((value >>> bits) | (value << (32 - bits))) >>> 0;
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  class Sha256 {
    constructor() {
      this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
      this.buffer = new Uint8Array(64);
      this.bufferLength = 0;
      this.bytesHashed = 0;
      this.finished = false;
      this.digestHex = null;
    }
    update(input) {
      if (this.finished) throw new Error("sha256 finalized");
      const data = input instanceof Uint8Array ? input : new Uint8Array(input);
      this.bytesHashed += data.byteLength;
      let position = 0;
      while (position < data.byteLength) {
        const take = Math.min(data.byteLength - position, 64 - this.bufferLength);
        this.buffer.set(data.subarray(position, position + take), this.bufferLength);
        this.bufferLength += take;
        position += take;
        if (this.bufferLength === 64) { this.compress(this.buffer); this.bufferLength = 0; }
      }
      return this;
    }
    compress(chunk) {
      const w = new Uint32Array(64);
      for (let i = 0; i < 16; i += 1) {
        const j = i * 4;
        w[i] = ((chunk[j] << 24) | (chunk[j + 1] << 16) | (chunk[j + 2] << 8) | chunk[j + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i += 1) {
        const x = w[i - 15], y = w[i - 2];
        const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
        const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,h] = this.h;
      for (let i = 0; i < 64; i += 1) {
        const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const t1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
        const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const t2 = (s0 + maj) >>> 0;
        h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
      }
      this.h[0]=(this.h[0]+a)>>>0; this.h[1]=(this.h[1]+b)>>>0; this.h[2]=(this.h[2]+c)>>>0; this.h[3]=(this.h[3]+d)>>>0;
      this.h[4]=(this.h[4]+e)>>>0; this.h[5]=(this.h[5]+f)>>>0; this.h[6]=(this.h[6]+g)>>>0; this.h[7]=(this.h[7]+h)>>>0;
    }
    hex() {
      if (this.digestHex) return this.digestHex;
      const bitLength = this.bytesHashed * 8;
      const padded = new Uint8Array(this.bufferLength < 56 ? 64 : 128);
      padded.set(this.buffer.subarray(0, this.bufferLength));
      padded[this.bufferLength] = 0x80;
      const high = Math.floor(bitLength / 0x100000000), low = bitLength >>> 0, end = padded.length;
      padded[end-8]=(high>>>24)&255; padded[end-7]=(high>>>16)&255; padded[end-6]=(high>>>8)&255; padded[end-5]=high&255;
      padded[end-4]=(low>>>24)&255; padded[end-3]=(low>>>16)&255; padded[end-2]=(low>>>8)&255; padded[end-1]=low&255;
      for (let offset = 0; offset < padded.length; offset += 64) this.compress(padded.subarray(offset, offset + 64));
      this.finished = true;
      this.digestHex = Array.from(this.h, (value) => value.toString(16).padStart(8, "0")).join("");
      return this.digestHex;
    }
  }

  function bytesToBase64(bytes, btoaFn) {
    let binary = "";
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000)));
    }
    return btoaFn(binary);
  }
  function withTimeout(promise, ms, onTimeout) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { onTimeout?.(); } catch {}
          reject(assetError("BROWSER_ASSET_TIMEOUT", "stream_io_timeout"));
        }, ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function createTransferRuntime(environment = {}) {
    const discoveryRuntime = environment.discoveryRuntime;
    const fetchFn = environment.fetch || globalThis.fetch?.bind(globalThis);
    const cryptoApi = environment.crypto || globalThis.crypto;
    const btoaFn = environment.btoa || globalThis.btoa?.bind(globalThis);
    const now = environment.now || (() => Date.now());
    const ioTimeoutMs = Number.isFinite(environment.ioTimeoutMs) && Number(environment.ioTimeoutMs) > 0
      ? Number(environment.ioTimeoutMs)
      : IO_TIMEOUT_MS;
    if (!discoveryRuntime?.validateForOpen || typeof fetchFn !== "function" || !cryptoApi?.randomUUID || typeof btoaFn !== "function") {
      throw new Error("asset transfer environment is incomplete");
    }
    const transfers = new Map();
    const activeRequests = new Map();

    async function closeTransfer(transfer, reason = "closed") {
      transfers.delete(transfer.assetHandle);
      try { transfer.controller.abort(); } catch {}
      try { await transfer.reader.cancel(reason); } catch {}
    }
    function cleanup() {
      const current = now();
      for (const transfer of transfers.values()) {
        if (transfer.expiresAt <= current) void closeTransfer(transfer, "ttl_expired");
      }
    }
    function resolveTransfer(handle) {
      cleanup();
      const transfer = transfers.get(String(handle || ""));
      if (!transfer) throw assetError("BROWSER_ASSET_TRANSFER_PROTOCOL", "asset_handle_unknown_or_expired");
      if (transfer.expiresAt <= now()) {
        void closeTransfer(transfer, "ttl_expired");
        throw assetError("BROWSER_ASSET_TRANSFER_PROTOCOL", "asset_handle_expired");
      }
      return transfer;
    }

    async function openAsset(assetRef, options = {}) {
      const validated = discoveryRuntime.validateForOpen(assetRef, { expected_document_id: options.expected_document_id });
      const maxAssetBytes = Number(options.max_asset_bytes ?? DEFAULT_MAX_ASSET_BYTES);
      if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes <= 0) {
        throw assetError("BROWSER_ASSET_TRANSFER_PROTOCOL", "invalid_max_asset_bytes");
      }
      if (transfers.size >= MAX_ACTIVE_TRANSFERS) throw assetError("BROWSER_ASSET_FETCH_FAILED", "active_transfer_limit_reached");
      const requestId = safeText(options.request_id || cryptoApi.randomUUID(), 200);
      const controller = new AbortController();
      activeRequests.set(requestId, { controller, handle: null });
      let response;
      try {
        response = await withTimeout(fetchFn(validated.selected_source, {
          credentials: "include",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        }), ioTimeoutMs, () => controller.abort());
      } catch (error) {
        activeRequests.delete(requestId);
        if (error?.code === "BROWSER_ASSET_TIMEOUT") throw error;
        if (controller.signal.aborted) throw assetError("BROWSER_ASSET_ABORTED", "fetch_aborted");
        throw assetError("BROWSER_ASSET_FETCH_FAILED", "redirect_or_network_failure");
      }
      if (!response?.ok) {
        activeRequests.delete(requestId); controller.abort();
        throw assetError("BROWSER_ASSET_FETCH_FAILED", "non_success_response");
      }
      const rawLength = response.headers?.get?.("content-length") || null;
      const contentLength = rawLength === null ? null : Number(rawLength);
      if (Number.isFinite(contentLength) && contentLength > maxAssetBytes) {
        activeRequests.delete(requestId); controller.abort();
        throw assetError("BROWSER_ASSET_SIZE_LIMIT", "content_length_exceeds_limit");
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        activeRequests.delete(requestId); controller.abort();
        throw assetError("BROWSER_ASSET_FETCH_FAILED", "bounded_stream_unavailable");
      }
      let reader;
      try { reader = response.body.getReader({ mode: "byob" }); }
      catch { activeRequests.delete(requestId); controller.abort(); throw assetError("BROWSER_ASSET_FETCH_FAILED", "byob_reader_unavailable"); }

      const assetHandle = `content_handle_v1_${cryptoApi.randomUUID()}`;
      const transferId = `content_transfer_v1_${cryptoApi.randomUUID()}`;
      const transfer = {
        assetHandle, transferId, reader, controller, hasher: new Sha256(), bytes: 0,
        nextSequence: 0, nextOffset: 0, replay: null, terminal: false, busy: false,
        maxAssetBytes, expiresAt: now() + TRANSFER_TTL_MS,
      };
      transfers.set(assetHandle, transfer);
      activeRequests.delete(requestId);
      return {
        transfer_id: transferId,
        asset_handle: assetHandle,
        mime_type: safeText(response.headers?.get?.("content-type") || "application/octet-stream", 120).split(";", 1)[0] || "application/octet-stream",
        content_length: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null,
        next_sequence: 0,
        next_offset: 0,
        representation_binding: "source-revalidated",
        max_raw_chunk_bytes: MAX_RAW_CHUNK_BYTES,
        replay_window_chunks: 1,
      };
    }

    async function readChunk(handle, request = {}) {
      const transfer = resolveTransfer(handle);
      const sequence = Number(request.sequence), offset = Number(request.offset), maxRawBytes = Number(request.max_raw_bytes);
      if (transfer.replay && sequence === transfer.replay.sequence && offset === transfer.replay.offset) return transfer.replay;
      if (transfer.busy) throw assetError("BROWSER_ASSET_TRANSFER_PROTOCOL", "chunk_already_in_flight");
      if (transfer.terminal) throw assetError("BROWSER_ASSET_TRANSFER_PROTOCOL", "read_after_terminal");
      if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(offset) || sequence !== transfer.nextSequence || offset !== transfer.nextOffset) {
        await closeTransfer(transfer, "protocol_position_mismatch");
        throw assetError("BROWSER_ASSET_TRANSFER_PROTOCOL", "sequence_or_offset_mismatch");
      }
      if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes <= 0 || maxRawBytes > MAX_RAW_CHUNK_BYTES) {
        await closeTransfer(transfer, "invalid_chunk_budget");
        throw assetError("BROWSER_ASSET_TRANSFER_PROTOCOL", "invalid_max_raw_bytes");
      }
      const requestId = safeText(request.request_id || cryptoApi.randomUUID(), 200);
      transfer.busy = true;
      transfer.replay = null;
      activeRequests.set(requestId, { controller: transfer.controller, handle: transfer.assetHandle });
      let value, done = false;
      try {
        for (let emptyReads = 0; emptyReads < 16; emptyReads += 1) {
          const result = await withTimeout(
            transfer.reader.read(new Uint8Array(maxRawBytes)),
            ioTimeoutMs,
            () => transfer.controller.abort(),
          );
          value = result.value; done = Boolean(result.done);
          if (done || (value && value.byteLength > 0)) break;
        }
      } catch (error) {
        activeRequests.delete(requestId);
        transfer.busy = false;
        await closeTransfer(transfer, "read_failed");
        if (error?.code === "BROWSER_ASSET_TIMEOUT") throw error;
        if (transfer.controller.signal.aborted) throw assetError("BROWSER_ASSET_ABORTED", "stream_aborted");
        throw assetError("BROWSER_ASSET_FETCH_FAILED", "stream_read_failed");
      }
      activeRequests.delete(requestId);
      transfer.busy = false;
      const bytes = value && value.byteLength > 0 ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(0);
      if (!done && bytes.byteLength === 0) {
        await closeTransfer(transfer, "empty_read_limit");
        throw assetError("BROWSER_ASSET_TRANSFER_PROTOCOL", "repeated_empty_stream_reads");
      }
      if (transfer.bytes + bytes.byteLength > transfer.maxAssetBytes) {
        await closeTransfer(transfer, "stream_limit_exceeded");
        throw assetError("BROWSER_ASSET_SIZE_LIMIT", "streaming_bytes_exceed_limit");
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
        ...(done ? { terminal: { acquisition_bytes: transfer.bytes, acquisition_sha256: transfer.hasher.hex() } } : {}),
      };
      transfer.replay = response;
      transfer.nextSequence = sequence + 1;
      transfer.nextOffset = offset + bytes.byteLength;
      transfer.terminal = done;
      transfer.expiresAt = now() + TRANSFER_TTL_MS;
      return response;
    }

    async function closeAsset(handle) {
      const transfer = transfers.get(String(handle || ""));
      if (transfer) await closeTransfer(transfer, "explicit_close");
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
    async function closeAll() {
      await Promise.all(Array.from(transfers.values(), (transfer) => closeTransfer(transfer, "runtime_teardown")));
    }
    return {
      openAsset, readChunk, closeAsset, cancelRequest, closeAll,
      limits: { transfer_ttl_ms: TRANSFER_TTL_MS, max_raw_chunk_bytes: MAX_RAW_CHUNK_BYTES, max_active_transfers: MAX_ACTIVE_TRANSFERS, io_timeout_ms: ioTimeoutMs },
    };
  }

  globalThis.ZameryAssetTransferV1 = Object.freeze({ createTransferRuntime, normalizeAssetError });
})();
