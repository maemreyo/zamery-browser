# AMO listed release

This directory contains the metadata and release checklist for the first public addons.mozilla.org listing of **Zamery Browser Companion**.

Current candidate: `0.1.3` with stable Gecko ID `zamery-browser-firefox@zamery.local`.

## Why 0.1.3

The currently distributed Mozilla-signed companion is `0.1.2` on the unlisted/self-distributed channel. The first listed build uses a higher version so existing self-distributed installations can move forward to the public AMO release rather than attempting to reuse an already-distributed version.

## Production source boundary

Only these files belong in the production submission:

- `asset-discovery-v1.js`
- `asset-transfer-v1.js`
- `background.js`
- `content.js`
- `manifest.json`
- `popup.html`
- `popup.js`

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
  --amo-metadata packages/browser-firefox/amo/metadata-listed.json \
  --api-key "$WEB_EXT_API_KEY" \
  --api-secret "$WEB_EXT_API_SECRET"
```

The AMO listing must also identify that the add-on has a privacy policy and use the public policy at:

`https://github.com/maemreyo/zamery-browser/blob/main/PRIVACY.md`

## Release gate

Do not merge the `0.1.3` manifest bump or replace the current `0.1.2` self-distributed release until the listed AMO submission has been accepted/published and the final public listing/version has been re-observed.
