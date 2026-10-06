# AMO listed release

This directory contains the metadata and release checklist for the first public addons.mozilla.org listing of **Zamery Browser Companion**.

Current public AMO version: `0.2.3` (companion protocol 2) with stable Gecko ID `zamery-browser-firefox@zamery.local`. Mozilla automated screening approved it for the public listing on 2026-10-06 (AMO version `6546568`). Current source candidate `0.2.4` completes the Companion branding with the public product name, brand header, user-facing extension description, and AMO listing copy. The signed `0.2.2` XPI remains the recorded stable release artifact until a newer exact signed-XPI digest/source tuple is captured in release evidence.

## Why 0.2.4

`0.2.3` is already public on AMO. Updating the popup and manifest changes signed source bytes, so the completed Companion branding uses `0.2.4` even though browser-control semantics and native wire protocol remain unchanged. A listed/signed build always uses a version higher than an already-distributed build so existing installations can move forward rather than attempting to reuse a signed artifact built from different source.

## Production source boundary

Only these files belong in the production submission:

The file set is derived from `manifest.json` by `scripts/firefox-amo-listed.sh` (background scripts, content scripts, popup page and script, and the manifest itself), so it cannot drift from what the extension loads. Today that is:

- `asset-discovery-v1.js`
- `asset-transfer-v1.js`
- `background.js`
- `content.js`
- `control-ops.js`
- `icons/zamery-16.png`
- `icons/zamery-32.png`
- `icons/zamery-48.png`
- `icons/zamery-96.png`
- `icons/zamery-128.png`
- `manifest.json`
- `policy.js`
- `popup.html`
- `popup.js`
- `start.js`

Do not include development manifests, experimental assets, repository state, credentials, or temporary signing files.

## Preflight

From the repository root:

```bash
pnpm build
pnpm typecheck
pnpm dlx web-ext@10.6.0 lint --source-dir <staged-production-source>
```

The first listed submission must use `metadata-listed.json` and channel `listed`.

## Submission

Create AMO API credentials in the Mozilla Developer Hub and expose them only in the local shell. Do not commit, paste into source files, or add them to release artifacts.

```bash
pnpm dlx web-ext@10.6.0 sign \
  --source-dir <staged-production-source> \
  --channel listed \
  --approval-timeout 0 \
  --amo-metadata packages/browser-firefox/amo/metadata-listed.json \
  --api-key "$WEB_EXT_API_KEY" \
  --api-secret "$WEB_EXT_API_SECRET"
```

For a listed submission, successful upload and validation do not imply immediate approval. `--approval-timeout 0` returns after submission instead of turning an expected manual-review wait into a CLI timeout failure. Treat the result as submitted/pending review until the Developer Hub shows the version accepted and public.

The AMO listing must also identify that the add-on has a privacy policy and use the public policy at:

`https://github.com/maemreyo/zamery-browser/blob/main/PRIVACY.md`

## Release gate

Companion `0.2.3` is approved and public on AMO; `0.2.4` is the current branding source candidate. Before promoting `0.2.4` as the repository's recorded stable release artifact, capture the exact signed XPI SHA-256 and source tuple with `pnpm release:tuple --xpi <signed-0.2.4.xpi>` and update the durable release evidence. Until then, the signed `0.2.2` XPI remains the recorded stable artifact.
