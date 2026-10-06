# AMO listed release

This directory contains the metadata and release checklist for the first public addons.mozilla.org listing of **Zamery Browser Companion**.

Current public AMO version: `0.2.3` (companion protocol 2) with stable Gecko ID `zamery-browser-firefox@zamery.local`. It adds the public Zamery Browser icon/toolbar branding on top of the accepted `0.2.2` runtime. Mozilla automated screening approved `0.2.3` for the public listing on 2026-10-06 (AMO version `6546568`). The signed `0.2.2` XPI remains the recorded stable release artifact until the exact `0.2.3` signed-XPI digest/source tuple is captured in release evidence.

## Why 0.2.3

`0.2.2` is already Mozilla-signed and distributed. Adding extension icons changes the signed source bytes, so the branded source uses `0.2.3` even though browser-control semantics and native wire protocol remain unchanged. A listed/signed build always uses a version higher than an already-distributed build so existing installations can move forward rather than attempting to reuse a signed artifact built from different source.

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

Companion `0.2.3` is approved and public on AMO. Before promoting it as the repository's recorded stable release artifact, capture the exact signed XPI SHA-256 and source tuple with `pnpm release:tuple --xpi <signed-0.2.3.xpi>` and update the durable release evidence. Until then, the signed `0.2.2` XPI remains the recorded stable artifact.
