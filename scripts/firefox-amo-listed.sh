#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT/packages/browser-firefox/runtime/companion"
METADATA="$ROOT/packages/browser-firefox/amo/metadata-listed.json"
OUT_DIR="${FIREFOX_AMO_ARTIFACTS_DIR:-$ROOT/.tmp/firefox-amo-listed}"
STAGED_SOURCE="$OUT_DIR/source"
MODE="${1:-prepare}"

case "$MODE" in
  prepare|submit) ;;
  *)
    printf 'Usage: %s [prepare|submit]\n' "$0" >&2
    exit 2
    ;;
esac

rm -rf "$OUT_DIR"
mkdir -p "$STAGED_SOURCE"

for asset in \
  asset-discovery-v1.js \
  asset-transfer-v1.js \
  background.js \
  content.js \
  manifest.json \
  popup.html \
  popup.js; do
  cp "$SOURCE_DIR/$asset" "$STAGED_SOURCE/$asset"
done

node --input-type=module - "$STAGED_SOURCE/manifest.json" "$METADATA" <<'NODE'
import fs from "node:fs";

const [manifestPath, metadataPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

if (manifest.name !== "Zamery Browser Companion") {
  throw new Error(`unexpected companion name: ${manifest.name}`);
}
if (manifest.browser_specific_settings?.gecko?.id !== "zamery-browser-firefox@zamery.local") {
  throw new Error("unexpected or missing stable Gecko ID");
}
if (!metadata.summary?.["en-US"]) {
  throw new Error("AMO metadata requires summary.en-US");
}
if (!Array.isArray(metadata.categories) || metadata.categories.length === 0) {
  throw new Error("AMO metadata requires at least one category");
}
if (metadata.version?.license !== "Apache-2.0") {
  throw new Error("AMO metadata license must be Apache-2.0");
}
if (!metadata.version?.approval_notes) {
  throw new Error("AMO metadata requires reviewer approval notes");
}

console.log(`AMO candidate ${manifest.version} · ${manifest.browser_specific_settings.gecko.id}`);
NODE

pnpm dlx web-ext@10.6.0 lint --source-dir "$STAGED_SOURCE"

node --input-type=module - "$STAGED_SOURCE" <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sourceDir = process.argv[2];
const files = fs.readdirSync(sourceDir).sort();
const hash = crypto.createHash("sha256");
for (const file of files) {
  const fullPath = path.join(sourceDir, file);
  if (!fs.statSync(fullPath).isFile()) continue;
  hash.update(file);
  hash.update("\0");
  hash.update(fs.readFileSync(fullPath));
  hash.update("\0");
}
console.log(`AMO_SOURCE_SHA256=${hash.digest("hex")}`);
NODE

pnpm dlx web-ext@10.6.0 build \
  --source-dir "$STAGED_SOURCE" \
  --artifacts-dir "$OUT_DIR" \
  --overwrite-dest

node --input-type=module - "$OUT_DIR" <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2];
const archives = fs.readdirSync(outDir).filter((name) => name.endsWith(".zip"));
if (archives.length !== 1) {
  throw new Error(`expected exactly one AMO ZIP, found ${archives.length}`);
}
const archive = path.join(outDir, archives[0]);
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
console.log(`AMO_ZIP=${archive}`);
console.log(`AMO_ZIP_SHA256_OBSERVED=${sha256}`);
NODE

if [[ "$MODE" == "prepare" ]]; then
  exit 0
fi

if [[ -z "${WEB_EXT_API_KEY:-}" || -z "${WEB_EXT_API_SECRET:-}" ]]; then
  printf 'WEB_EXT_API_KEY and WEB_EXT_API_SECRET are required for AMO submission.\n' >&2
  exit 2
fi

pnpm dlx web-ext@10.6.0 sign \
  --source-dir "$STAGED_SOURCE" \
  --artifacts-dir "$OUT_DIR" \
  --channel listed \
  --amo-metadata "$METADATA" \
  --api-key "$WEB_EXT_API_KEY" \
  --api-secret "$WEB_EXT_API_SECRET"
