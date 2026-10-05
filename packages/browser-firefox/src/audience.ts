import { createHash, randomUUID } from "node:crypto";

const AUDIENCE_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * A consumer audience is the unit a Firefox grant, journal partition and artifact store are bound to.
 * It is a same-OS-user routing key, not an authenticated identity. Ids the native host would reject are
 * hashed rather than passed through, so a Pi `clientId` or an MCP consumer id always yields a valid audience.
 */
export function normalizeAudienceId(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return randomUUID();
  if (AUDIENCE_PATTERN.test(value)) return value;
  return `a-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}
