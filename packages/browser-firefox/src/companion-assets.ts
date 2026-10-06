import { fileURLToPath } from "node:url";

export type FirefoxCompanionManifestKind = "production" | "development";

export function firefoxCompanionManifestPath(kind: FirefoxCompanionManifestKind): string {
  const file = kind === "production" ? "manifest.json" : "manifest.development.json";
  return fileURLToPath(new URL(`../runtime/companion/${file}`, import.meta.url));
}

export type FirefoxCompanionAssetFile =
  | "asset-discovery-v1.js"
  | "asset-transfer-v1.js"
  | "background.js"
  | "content.js"
  | "control-ops.js"
  | "policy.js"
  | "popup.html"
  | "popup.js"
  | "start.js";

export function firefoxCompanionAssetPath(file: FirefoxCompanionAssetFile): string {
  return fileURLToPath(new URL(`../runtime/companion/${file}`, import.meta.url));
}
