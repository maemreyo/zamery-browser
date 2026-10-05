# AMO listed release

This directory contains the metadata and release checklist for the first public addons.mozilla.org listing of **Zamery Browser Companion**.

Current candidate: `0.2.0` (companion protocol 2: scoped consent, tab groups, screenshots) with stable Gecko ID `zamery-browser-firefox@zamery.local`.

## Why 0.2.0

The currently distributed Mozilla-signed companion is `0.1.2` on the unlisted/self-distributed channel. The companion changed its native wire protocol (1 → 2) and requests the new `tabGroups` permission, so it ships as a new minor version. A listed build always uses a higher version so existing self-distributed installations can move forward to the public AMO release rather than attempting to reuse an already-distributed version.

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

Do not replace the currently distributed signed companion (`0.1.2`/`0.1.3`, protocol 1) with `0.2.0` (protocol 2) until the technical-preview acceptance matrix in `docs/technical-preview.md` has passed for the exact release-candidate tuple (`pnpm release:tuple`), and the signed XPI SHA-256 has been recorded. Protocol-1 and protocol-2 components are intentionally incompatible and fail closed together.
