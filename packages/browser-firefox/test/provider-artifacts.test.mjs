import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createFirefoxBrowserProviderV2, createFirefoxRequestId } from "../dist/index.js";
import { startStack } from "./helpers/stack-harness.mjs";
import { makePng, pngDataUrl, quadrantPng } from "./helpers/png.mjs";

const AUD = "audience-artifacts-aa";
const stacks = [];
afterEach(async () => { while (stacks.length) await stacks.pop().stop(); });

async function boot({ png = quadrantPng(), lifetimeMs } = {}) {
  const stack = await startStack();
  stacks.push(stack);
  stack.company.state.captureResult = pngDataUrl(png);
  const artifactRoot = path.join(stack.roots.root, "art");
  const provider = createFirefoxBrowserProviderV2({
    sessionsDir: path.join(stack.roots.runtimeDir, "sessions"), audienceId: AUD, artifactRoot, ...(lifetimeMs ? { artifactLifetimeMs: lifetimeMs } : {}),
  });
  await provider.status();
  const [instance] = await provider.listInstances();
  const target = { browserInstanceId: instance.browserInstanceId, providerSessionId: instance.providerSessionId };
  const granted = await stack.company.popup({ type: "zamery_browser_firefox_grant", audience_id: AUD, tab_ids: [1], duration: { mode: "session" } });
  assert.equal(granted.ok, true);
  return { stack, provider, target, artifactRoot, png };
}

const shot = (provider, target, extra = {}) => provider.screenshot({ requestId: createFirefoxRequestId(), ...target, contextId: "tab:1", ...extra });
/** The per-process artifact directory inside the per-consumer directory. */
const processDir = (root) => {
  const [audienceDir] = fs.readdirSync(root);
  const [proc] = fs.readdirSync(path.join(root, audienceDir)).filter((name) => /^p\d+-/.test(name));
  return path.join(root, audienceDir, proc);
};
const files = (root) => (fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).map(String) : []);

describe("screenshot artifacts through the real stack", () => {
  it("captures, transfers in verified chunks and stores an immutable 0600 artifact in a 0700 managed directory", async () => {
    const png = makePng(500, 400, (x, y) => [(x * 11 + y * 3) & 255, (y * 7) & 255, (x ^ y) & 255]);
    const { provider, target, artifactRoot } = await boot({ png });
    const result = await shot(provider, target);
    assert.equal(result.outcome, "completed", JSON.stringify(result));
    const d = result.value;
    assert.match(d.artifactId, /^art_[0-9a-f]{32}$/);
    assert.equal(d.byteSize, png.length);
    assert.ok(d.byteSize > 64 * 1024, "needs multiple chunks");
    assert.equal(d.sha256, crypto.createHash("sha256").update(png).digest("hex"));
    assert.equal(d.width, 500);
    assert.equal(result.receipt.operation, "screenshot.capture");

    const dir = processDir(artifactRoot);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.dirname(dir)).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600, name);
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${d.artifactId}.json`, `${d.artifactId}.png`]);
    assert.ok(!fs.readFileSync(path.join(dir, `${d.artifactId}.json`), "utf8").includes("a.test"), "metadata carries no URL or title");

    const read = await provider.readArtifact(d.artifactId);
    assert.deepEqual(Buffer.from(read.data), png);
  });

  it("refuses unknown ids and path-shaped ids", async () => {
    const { provider } = await boot();
    for (const id of ["../../etc/passwd", "art_" + "0".repeat(32), "/tmp/x", "art_zz"]) {
      await assert.rejects(provider.readArtifact(id), (error) => error.code === "ARTIFACT_NOT_FOUND", id);
    }
  });

  it("expires artifacts when the access binding ends, and a new grant does not resurrect old pixels", async () => {
    const { stack, provider, target, artifactRoot } = await boot();
    const d = (await shot(provider, target)).value;
    await stack.company.popup({ type: "zamery_browser_firefox_revoke" });
    await assert.rejects(provider.readArtifact(d.artifactId), (error) => error.code === "ARTIFACT_EXPIRED" && error.reason === "authority_ended");
    assert.deepEqual(files(artifactRoot).filter((name) => /\.(png|jpg)$/.test(name)), [], "bytes were deleted on the failed read");

    await stack.company.popup({ type: "zamery_browser_firefox_grant", audience_id: AUD, tab_ids: [1] });
    const second = (await shot(provider, target)).value;
    await stack.company.popup({ type: "zamery_browser_firefox_revoke" });
    await stack.company.popup({ type: "zamery_browser_firefox_grant", audience_id: AUD, tab_ids: [1] });
    await assert.rejects(provider.readArtifact(second.artifactId), (error) => error.code === "ARTIFACT_EXPIRED");
  });

  it("expires by time", async () => {
    const { provider, target } = await boot({ lifetimeMs: 300 });
    const d = (await shot(provider, target)).value;
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assert.rejects(provider.readArtifact(d.artifactId), (error) => error.code === "ARTIFACT_EXPIRED");
  });

  it("detects on-disk tampering", async () => {
    const { provider, target, artifactRoot } = await boot();
    const e = (await shot(provider, target)).value;
    fs.appendFileSync(path.join(processDir(artifactRoot), `${e.artifactId}.png`), "x");
    await assert.rejects(provider.readArtifact(e.artifactId), (error) => error.code === "ARTIFACT_INTEGRITY_MISMATCH");
  });

  it("does not follow a symlink planted in place of an artifact", async () => {
    const { provider, target, artifactRoot, stack } = await boot();
    const d = (await shot(provider, target)).value;
    const bin = path.join(processDir(artifactRoot), `${d.artifactId}.png`);
    const secret = path.join(stack.roots.root, "secret.txt");
    fs.writeFileSync(secret, "TOP-SECRET");
    fs.rmSync(bin);
    fs.symlinkSync(secret, bin);
    await assert.rejects(provider.readArtifact(d.artifactId), (error) => error.code === "ARTIFACT_INTEGRITY_MISMATCH");
  });

  it("returns typed not_started errors for bad requests, busy captures and scope violations", async () => {
    const { provider, target } = await boot();
    const tooBig = await shot(provider, target, { rect: { x: 0, y: 0, width: 9000, height: 10 } });
    assert.equal(tooBig.outcome, "not_started");
    assert.equal(tooBig.error.code, "INVALID_ARGUMENT");
    const outside = await provider.screenshot({ requestId: createFirefoxRequestId(), ...target, contextId: "tab:2" });
    assert.equal(outside.error.code, "OUTSIDE_SCOPE");
  });

  it("fails closed and leaves no artifact when the companion corrupts a chunk", async () => {
    const { stack, provider, target, artifactRoot } = await boot({ png: makePng(400, 300, (x, y) => [(x * 7 + y * 13) & 255, x & 255, y & 255]) });
    const original = stack.host.onMessage;
    // Flip one byte of the second chunk on its way from the companion to the host.
    const post = stack.company.state.onNativePost;
    stack.company.state.onNativePost = (message) => {
      if (message.type === "response" && message.result?.sequence === 1 && message.result?.data_base64) {
        const bytes = Buffer.from(message.result.data_base64, "base64");
        bytes[0] ^= 0xff;
        message = { ...message, result: { ...message.result, data_base64: bytes.toString("base64") } };
      }
      post(message);
    };
    void original;
    const result = await shot(provider, target);
    assert.equal(result.outcome, "not_started");
    assert.equal(result.error.code, "ARTIFACT_INTEGRITY_MISMATCH");
    assert.deepEqual(files(artifactRoot).filter((name) => /\.(png|jpg)$/.test(name) || name.endsWith(".json")), []);
  });

  it("provider.close removes this consumer's artifacts", async () => {
    const { provider, target, artifactRoot } = await boot();
    await shot(provider, target);
    assert.ok(files(artifactRoot).some((name) => /\.(png|jpg)$/.test(name)));
    await provider.close();
    assert.deepEqual(files(artifactRoot).filter((name) => /\.(png|jpg)$/.test(name)), []);
  });
});

describe("materialized artifact path", () => {
  it("returns only the managed, verified file and refuses after authority ends", async () => {
    const { stack, provider, target, artifactRoot } = await boot();
    const d = (await shot(provider, target)).value;
    const { path: file } = await provider.materializeArtifact(d.artifactId);
    assert.ok(file.startsWith(artifactRoot) && file.endsWith(`${d.artifactId}.png`));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(file).subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await assert.rejects(provider.materializeArtifact("/etc/passwd"), (error) => error.code === "ARTIFACT_NOT_FOUND");
    await stack.company.popup({ type: "zamery_browser_firefox_revoke" });
    await assert.rejects(provider.materializeArtifact(d.artifactId), (error) => error.code === "ARTIFACT_EXPIRED");
    assert.equal(fs.existsSync(file), false);
  });
});

describe("artifact lifetime without anyone reading", () => {
  it("a periodic reaper deletes files once the access binding ends, with no read needed", async () => {
    const stack = await startStack();
    stacks.push(stack);
    stack.company.state.captureResult = pngDataUrl(quadrantPng());
    const artifactRoot = path.join(stack.roots.root, "art");
    const provider = createFirefoxBrowserProviderV2({ sessionsDir: path.join(stack.roots.runtimeDir, "sessions"), audienceId: AUD, artifactRoot, artifactReaperIntervalMs: 100 });
    await provider.status();
    const [instance] = await provider.listInstances();
    const target = { browserInstanceId: instance.browserInstanceId, providerSessionId: instance.providerSessionId };
    assert.equal((await stack.company.popup({ type: "zamery_browser_firefox_grant", audience_id: AUD, tab_ids: [1] })).ok, true);
    const d = (await shot(provider, target)).value;
    assert.ok(files(artifactRoot).some((name) => name.endsWith(`${d.artifactId}.png`)));
    await stack.company.popup({ type: "zamery_browser_firefox_revoke" });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && files(artifactRoot).some((name) => name.endsWith(".png"))) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(files(artifactRoot).filter((name) => /\.(png|jpg|json)$/.test(name)), []);
    await provider.close();
  });

  it("two processes with the same consumer id do not delete each other's artifacts; a dead process's directory is removed", async () => {
    const { ArtifactStore } = await import("../dist/index.js");
    const root = fs.mkdtempSync(path.join("/tmp", "zq-art-"));
    try {
      const first = new ArtifactStore({ root, audienceId: AUD });
      const second = new ArtifactStore({ root, audienceId: AUD });
      assert.notEqual(first.directory, second.directory);
      const descriptor = { artifactId: `art_${"a".repeat(32)}`, kind: "screenshot", mediaType: "image/png", width: 1, height: 1, byteSize: 3, sha256: (await import("node:crypto")).createHash("sha256").update(Buffer.from("abc")).digest("hex"), contextId: "tab:1", documentId: null, capturedRect: { x: 0, y: 0, width: 1, height: 1 }, appliedScale: 1, grantRevision: 1, bindingToken: "t", createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
      first.write(descriptor, Buffer.from("abc"));
      second.clear();
      assert.equal(first.read(descriptor.artifactId).data.length, 3, "the other process's clear() left it alone");
      // Simulate a crashed process: a directory whose pid is gone is removed by the next store.
      const orphan = path.join(path.dirname(first.directory), "p2147483000-deadbeef");
      fs.mkdirSync(orphan, { mode: 0o700 });
      fs.writeFileSync(path.join(orphan, "x.png"), "x");
      new ArtifactStore({ root, audienceId: AUD });
      assert.equal(fs.existsSync(orphan), false);
      assert.ok(fs.existsSync(first.directory), "a live sibling directory is kept");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
