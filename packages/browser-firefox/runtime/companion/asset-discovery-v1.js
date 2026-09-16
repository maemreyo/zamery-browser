(() => {
  const ASSET_REF_TTL_MS = 5 * 60 * 1000;
  const MAX_DISCOVERED_ASSETS = 100;
  const MAX_ASSET_REFS = 256;
  const MAX_SELECTED_SOURCE_CHARS = 16 * 1024;
  const REPRESENTATION_ROLES = new Set(["original", "preview", "thumbnail", "unknown"]);

  const safeText = (value, limit = 240) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  function safeLabelFor(element, fallback) {
    const candidate = safeText(
      element?.getAttribute?.("alt")
      || element?.getAttribute?.("aria-label")
      || element?.getAttribute?.("title")
      || fallback,
    );
    if (/https?:\/\/|data:|blob:|[?&](?:sig|token|key|auth|authorization)=|bearer\s/i.test(candidate)) return fallback;
    return candidate || fallback;
  }
  function assetError(code, reason) {
    const error = new Error(code);
    error.code = code;
    if (reason) error.reason = reason;
    return error;
  }
  function normalizeAssetError(error) {
    const code = typeof error?.code === "string" ? error.code : "BROWSER_ASSET_FETCH_FAILED";
    return { code, message: "browser asset operation failed", ...(typeof error?.reason === "string" ? { reason: safeText(error.reason, 120) } : {}) };
  }
  function mediaKindFor(element) {
    const tag = String(element?.tagName || "").toLowerCase();
    return tag === "img" ? "image" : tag === "audio" ? "audio" : tag === "video" ? "video" : null;
  }
  function selectedSourceFor(element, baseHref) {
    const selected = String(element?.currentSrc || element?.src || "").trim();
    if (!selected || selected.length > MAX_SELECTED_SOURCE_CHARS) return null;
    try {
      const parsed = new URL(selected, baseHref);
      return { url: parsed.href, origin: parsed.origin, protocol: parsed.protocol };
    } catch { return null; }
  }
  function representationRoleFor(element, resolver) {
    const resolved = typeof resolver === "function" ? resolver(element) : element?.getAttribute?.("data-zamery-asset-role");
    const role = String(resolved || "unknown").toLowerCase();
    return REPRESENTATION_ROLES.has(role) ? role : "unknown";
  }
  function dimensionsFor(element, kind) {
    if (kind === "image") {
      const width = Number(element?.naturalWidth) || 0;
      const height = Number(element?.naturalHeight) || 0;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (kind === "video") {
      const width = Number(element?.videoWidth) || 0;
      const height = Number(element?.videoHeight) || 0;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    return null;
  }
  function renderedFor(element, kind) {
    if (kind === "image") return Boolean(element?.complete && Number(element?.naturalWidth) > 0 && Number(element?.naturalHeight) > 0);
    return Number(element?.readyState) >= 1;
  }

  function createDiscoveryRuntime(environment = {}) {
    const doc = environment.document || globalThis.document;
    const loc = environment.location || globalThis.location;
    const cryptoApi = environment.crypto || globalThis.crypto;
    const now = environment.now || (() => Date.now());
    const documentId = String(environment.documentId || cryptoApi?.randomUUID?.() || "");
    const nodeIdForElement = typeof environment.nodeIdForElement === "function" ? environment.nodeIdForElement : (() => undefined);
    const roleResolver = environment.representationRoleFor;
    if (!doc || !loc || !cryptoApi?.randomUUID || !documentId) throw new Error("asset discovery environment is incomplete");
    const assetRefs = new Map();

    function cleanup() {
      const current = now();
      for (const [ref, entry] of assetRefs) if (entry.expiresAt <= current) assetRefs.delete(ref);
    }

    function discoverAssets() {
      cleanup();
      const assets = [];
      let order = 0;
      for (const element of Array.from(doc.querySelectorAll("img,audio,video"))) {
        if (assets.length >= MAX_DISCOVERED_ASSETS) break;
        if (!element?.isConnected || !doc.contains(element)) continue;
        const mediaKind = mediaKindFor(element);
        const source = mediaKind ? selectedSourceFor(element, loc.href) : null;
        if (!mediaKind || !source) continue;
        const role = representationRoleFor(element, roleResolver);
        const container = element.closest?.("[data-message-author-role], article, [role='article']") || null;
        const ref = `assetv1_${cryptoApi.randomUUID()}`;
        const discoveredAt = now();
        const expiresAt = discoveredAt + ASSET_REF_TTL_MS;
        const dimensions = dimensionsFor(element, mediaKind);
        assetRefs.set(ref, { ref, element, selectedSource: source.url, sourceOrigin: source.origin, sourceProtocol: source.protocol, role, mediaKind, expiresAt });
        while (assetRefs.size > MAX_ASSET_REFS) assetRefs.delete(assetRefs.keys().next().value);
        const elementNodeId = nodeIdForElement(element);
        const containerNodeId = container ? nodeIdForElement(container) : undefined;
        assets.push({
          asset_ref: ref,
          media_kind: mediaKind,
          safe_label: safeLabelFor(element, mediaKind),
          document_order: order++,
          rendered: renderedFor(element, mediaKind),
          ...(dimensions ? { intrinsic_width: dimensions.width, intrinsic_height: dimensions.height } : {}),
          representation: { role },
          ...(elementNodeId ? { element_node_id: String(elementNodeId) } : {}),
          ...(containerNodeId ? { container_node_id: String(containerNodeId) } : {}),
          discovered_at: discoveredAt,
          expires_at: expiresAt,
        });
      }
      return { document_id: documentId, assets };
    }

    function resolveAsset(ref) {
      cleanup();
      const entry = assetRefs.get(String(ref || ""));
      if (!entry) throw assetError("BROWSER_ASSET_REF_UNKNOWN", "unknown_or_evicted");
      if (entry.expiresAt <= now()) { assetRefs.delete(entry.ref); throw assetError("BROWSER_ASSET_REF_EXPIRED", "ttl_expired"); }
      return entry;
    }

    function validateForOpen(ref, options = {}) {
      const entry = resolveAsset(ref);
      if (String(options.expected_document_id || "") !== documentId) throw assetError("BROWSER_ASSET_STALE", "document_changed");
      if (!entry.element?.isConnected || !doc.contains(entry.element)) throw assetError("BROWSER_ASSET_STALE", "node_replaced_or_disconnected");
      const source = selectedSourceFor(entry.element, loc.href);
      if (!source || source.url !== entry.selectedSource) throw assetError("BROWSER_ASSET_STALE", "selected_source_changed");
      if (representationRoleFor(entry.element, roleResolver) !== entry.role) throw assetError("BROWSER_ASSET_STALE", "representation_changed");
      if (source.protocol !== "http:" && source.protocol !== "https:") throw assetError("BROWSER_ASSET_SCHEME_REFUSED", "scheme_not_http_https");
      if (source.origin !== loc.origin) throw assetError("BROWSER_ASSET_CROSS_ORIGIN_REFUSED", "source_origin_differs_from_document");
      return { selected_source: source.url, source_origin: source.origin, media_kind: entry.mediaKind, representation: { role: entry.role } };
    }

    return { discoverAssets, validateForOpen, limits: { asset_ref_ttl_ms: ASSET_REF_TTL_MS, max_discovered_assets: MAX_DISCOVERED_ASSETS, max_asset_refs: MAX_ASSET_REFS } };
  }

  globalThis.ZameryAssetDiscoveryV1 = { createDiscoveryRuntime, normalizeAssetError };
})();
