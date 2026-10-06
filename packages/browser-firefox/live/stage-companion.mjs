// Stages an isolated copy of the companion for live acceptance: different name, different extension id and a
// different native host name, so the user's installed companion/host/manifest are never involved.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ACCEPTANCE_HOST_NAME = "com.zamery.browser_firefox_acceptance";
export const ACCEPTANCE_EXTENSION_ID = "zamery-acceptance@zamery.local";

const SOURCE = fileURLToPath(new URL("../runtime/companion/", import.meta.url));

export function stageAcceptanceCompanion(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE, "manifest.json"), "utf8"));
  manifest.name = "Zamery Acceptance Companion (isolated)";
  manifest.browser_specific_settings.gecko.id = ACCEPTANCE_EXTENSION_ID;
  manifest.background.scripts = [...manifest.background.scripts.filter((file) => file !== "start.js"), "acceptance-ops.js", "start.js"];
  const files = new Set(["policy.js", "background.js", "control-ops.js", "artifacts.js", "agent-presence.js", "content.js", "popup.html", "popup.js", "asset-discovery-v1.js", "asset-transfer-v1.js", "start.js"]);
  for (const file of files) fs.copyFileSync(path.join(SOURCE, file), path.join(outDir, file));
  fs.copyFileSync(new URL("./acceptance-ops.js", import.meta.url), path.join(outDir, "acceptance-ops.js"));

  const patch = (file, from, to) => {
    const target = path.join(outDir, file);
    const text = fs.readFileSync(target, "utf8");
    if (!text.includes(from)) throw new Error(`stage patch anchor missing in ${file}: ${from.slice(0, 60)}`);
    fs.writeFileSync(target, text.replace(from, to));
  };
  patch("background.js", 'const HOST_NAME = "com.zamery.browser_firefox";', `const HOST_NAME = "${ACCEPTANCE_HOST_NAME}";`);
  // Acceptance operations are answered before authorization, exactly because they model the *user*, not the agent.
  patch("background.js", '  let lineage;\n  try {\n    lineage = authorizeRequest(message);', '  if (op.startsWith("acceptance_") && typeof executeAcceptanceOp === "function") {\n    try { respond(id, { replayed: false, ok: true, result: await executeAcceptanceOp(op, message.params || {}) }); } catch (error) { denied(id, error); }\n    return;\n  }\n\n  let lineage;\n  try {\n    lineage = authorizeRequest(message);');
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir: outDir, manifest };
}
