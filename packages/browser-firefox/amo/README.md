# AMO listed release

This directory contains the metadata and release checklist for the first public addons.mozilla.org listing of **Zamery Browser Companion**.

Current source candidate: `0.2.1` (companion protocol 2: scoped consent, tab groups, screenshots, explicit background control) with stable Gecko ID `zamery-browser-firefox@zamery.local`. It is not signed or published yet. The signed `0.2.0` XPI belongs to the previous source tuple and must not be reused as evidence for `0.2.1`.

## Why 0.2.1

`0.2.0` introduced companion protocol 2 and the `tabGroups` permission. Background automation changes the runtime authorization/dispatch semantics and popup consent surface, so the modified source uses `0.2.1` even though the native wire protocol remains 2. A listed build always uses a version higher than an already-distributed build so existing installations can move forward rather than attempting to reuse a signed artifact built from different source.

## Production source boundary

Only these files belong in the production submission:

The file set is derived from `manifest.json` by `scripts/firefox-amo-listed.sh` (background scripts, content scripts, popup page and script, and the manifest itself), so it cannot drift from what the extension loads. Today that is:

- `asset-discovery-v1.js`
- `asset-transfer-v1.js`
- `background.js`
- `content.js`
- `control-ops.js`
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

Do not publish or announce companion `0.2.1` until the technical-preview acceptance matrix in `docs/technical-preview.md` has passed for its exact release-candidate tuple (`pnpm release:tuple`) and the signed XPI SHA-256 has been recorded. The signed `0.2.0` XPI is retained only as historical evidence for its own source tuple.
