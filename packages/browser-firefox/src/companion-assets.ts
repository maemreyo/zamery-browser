import { fileURLToPath } from "node:url";

export type FirefoxCompanionManifestKind = "production" | "development";

export function firefoxCompanionManifestPath(kind: FirefoxCompanionManifestKind): string {
  const file = kind === "production" ? "manifest.json" : "manifest.development.json";
  return fileURLToPath(new URL(`../runtime/companion/${file}`, import.meta.url));
}

export function firefoxCompanionAssetPath(file: "background.js" | "content.js" | "popup.html" | "popup.js"): string {
  return fileURLToPath(new URL(`../runtime/companion/${file}`, import.meta.url));
}
