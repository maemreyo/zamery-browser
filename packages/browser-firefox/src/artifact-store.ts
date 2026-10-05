import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BROWSER_ARTIFACT_LIMITS_V1, type BrowserArtifactDescriptorV1 } from "@zamery/browser-provider";

const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{32}$/;

export class ArtifactError extends Error {
  readonly code: "ARTIFACT_EXPIRED" | "ARTIFACT_NOT_FOUND" | "ARTIFACT_INTEGRITY_MISMATCH" | "ARTIFACT_SIZE_LIMIT";
  readonly reason: string;

  constructor(code: ArtifactError["code"], reason: string, message: string) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
    this.reason = reason;
  }
}

export function defaultArtifactRoot(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Zamery", "browser-firefox", "artifacts", "screenshots");
}

export interface ArtifactStoreOptions {
  root?: string;
  audienceId: string;
  lifetimeMs?: number;
  maxBytes?: number;
  maxFiles?: number;
  now?: () => number;
}

/**
 * Per-audience managed artifact directory: opaque ids only, no caller-supplied paths, 0700 directory,
 * 0600 files created exclusively and finalized by atomic rename, no symlink following, expiry + size caps.
 */
export class ArtifactStore {
  readonly #dir: string;
  readonly #lifetimeMs: number;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #now: () => number;

  constructor(options: ArtifactStoreOptions) {
    const root = options.root ?? defaultArtifactRoot();
    const audienceKey = createHash("sha256").update(options.audienceId).digest("hex").slice(0, 24);
    this.#dir = path.join(root, audienceKey);
    this.#lifetimeMs = options.lifetimeMs ?? BROWSER_ARTIFACT_LIMITS_V1.defaultLifetimeMs;
    this.#maxBytes = options.maxBytes ?? BROWSER_ARTIFACT_LIMITS_V1.maxAudienceBytes;
    this.#maxFiles = options.maxFiles ?? 16;
    this.#now = options.now ?? (() => Date.now());
    fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.#dir, 0o700);
    if (fs.lstatSync(this.#dir).isSymbolicLink()) throw new Error("artifact directory must not be a symlink");
    this.sweep();
  }

  get directory(): string {
    return this.#dir;
  }

  get lifetimeMs(): number {
    return this.#lifetimeMs;
  }

  /** Bytes live in `<id>.png|jpg` so a host with an image viewer can open the file; metadata in `<id>.json`. */
  #paths(id: string, mediaType: string = "image/png"): { bin: string; meta: string } {
    if (!ARTIFACT_ID_PATTERN.test(id)) throw new ArtifactError("ARTIFACT_NOT_FOUND", "invalid_artifact_id", "unknown artifact id");
    const ext = mediaType === "image/jpeg" ? "jpg" : "png";
    return { bin: path.join(this.#dir, `${id}.${ext}`), meta: path.join(this.#dir, `${id}.json`) };
  }

  #writeExclusive(file: string, data: Uint8Array | string): void {
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  write(descriptor: BrowserArtifactDescriptorV1, data: Uint8Array): BrowserArtifactDescriptorV1 {
    if (data.byteLength > BROWSER_ARTIFACT_LIMITS_V1.maxEncodedBytes) throw new ArtifactError("ARTIFACT_SIZE_LIMIT", "artifact_too_large", "artifact exceeds the size limit");
    if (createHash("sha256").update(data).digest("hex") !== descriptor.sha256 || data.byteLength !== descriptor.byteSize) {
      throw new ArtifactError("ARTIFACT_INTEGRITY_MISMATCH", "digest_mismatch", "artifact bytes do not match their digest");
    }
    this.sweep(data.byteLength);
    const stored: BrowserArtifactDescriptorV1 = { ...descriptor, expiresAt: Math.min(descriptor.expiresAt, this.#now() + this.#lifetimeMs) };
    const { bin, meta } = this.#paths(descriptor.artifactId, descriptor.mediaType);
    // Bytes first, metadata last: a reader that finds metadata always finds complete bytes.
    this.#writeExclusive(bin, data);
    this.#writeExclusive(meta, `${JSON.stringify(stored)}\n`);
    return stored;
  }

  #readMeta(id: string): BrowserArtifactDescriptorV1 {
    const { meta } = this.#paths(id);
    let raw: string;
    try {
      const fd = fs.openSync(meta, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { raw = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
    } catch {
      throw new ArtifactError("ARTIFACT_NOT_FOUND", "artifact_not_found", "unknown or already removed artifact");
    }
    try {
      return JSON.parse(raw) as BrowserArtifactDescriptorV1;
    } catch {
      this.remove(id);
      throw new ArtifactError("ARTIFACT_INTEGRITY_MISMATCH", "metadata_unreadable", "artifact metadata is corrupt");
    }
  }

  describe(id: string): BrowserArtifactDescriptorV1 {
    const descriptor = this.#readMeta(id);
    if (descriptor.expiresAt <= this.#now()) {
      this.remove(id);
      throw new ArtifactError("ARTIFACT_EXPIRED", "artifact_expired", "artifact expired");
    }
    return descriptor;
  }

  read(id: string): { descriptor: BrowserArtifactDescriptorV1; data: Uint8Array } {
    const descriptor = this.describe(id);
    const { bin } = this.#paths(id, descriptor.mediaType);
    let data: Buffer;
    try {
      const fd = fs.openSync(bin, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const size = fs.fstatSync(fd).size;
        if (size !== descriptor.byteSize || size > BROWSER_ARTIFACT_LIMITS_V1.maxEncodedBytes) throw new Error("size mismatch");
        data = fs.readFileSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      this.remove(id);
      throw new ArtifactError("ARTIFACT_INTEGRITY_MISMATCH", "bytes_unreadable", "artifact bytes are missing or changed");
    }
    if (createHash("sha256").update(data).digest("hex") !== descriptor.sha256) {
      this.remove(id);
      throw new ArtifactError("ARTIFACT_INTEGRITY_MISMATCH", "digest_mismatch", "artifact bytes changed on disk");
    }
    return { descriptor, data };
  }

  remove(id: string): void {
    let meta: string;
    try { meta = this.#paths(id).meta; } catch { return; }
    // Metadata first so a concurrent reader can never see metadata without bytes.
    const files = [meta, path.join(this.#dir, `${id}.png`), path.join(this.#dir, `${id}.jpg`), path.join(this.#dir, `${id}.bin`)];
    for (const file of files) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
  }

  /** Drop expired artifacts and, if needed, the oldest ones until `incomingBytes` fit within the caps. */
  sweep(incomingBytes = 0): void {
    const entries: Array<{ id: string; createdAt: number; expiresAt: number; size: number }> = [];
    for (const name of fs.readdirSync(this.#dir)) {
      if (name.endsWith(".tmp")) {
        try { fs.unlinkSync(path.join(this.#dir, name)); } catch { /* ignore */ }
        continue;
      }
      const match = /^(art_[0-9a-f]{32})\.json$/.exec(name);
      if (!match) continue;
      const id = match[1]!;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.#dir, name), "utf8")) as BrowserArtifactDescriptorV1;
        entries.push({ id, createdAt: meta.createdAt, expiresAt: meta.expiresAt, size: meta.byteSize });
      } catch {
        this.remove(id);
      }
    }
    const now = this.#now();
    const live = entries.filter((entry) => {
      if (entry.expiresAt <= now) { this.remove(entry.id); return false; }
      return true;
    }).sort((a, b) => a.createdAt - b.createdAt);
    let total = live.reduce((sum, entry) => sum + entry.size, 0) + incomingBytes;
    let count = live.length + (incomingBytes > 0 ? 1 : 0);
    for (const entry of live) {
      if (total <= this.#maxBytes && count <= this.#maxFiles) break;
      this.remove(entry.id);
      total -= entry.size;
      count -= 1;
    }
  }

  /** Absolute path of the verified bytes, for hosts that open image files. Never accepts a caller path. */
  materializedPath(id: string): string {
    const { descriptor } = this.read(id);
    return this.#paths(id, descriptor.mediaType).bin;
  }

  clear(): void {
    for (const name of fs.readdirSync(this.#dir)) {
      const match = /^(art_[0-9a-f]{32})\.(json|bin|png|jpg)$/.exec(name);
      if (match) this.remove(match[1]!);
    }
  }
}
