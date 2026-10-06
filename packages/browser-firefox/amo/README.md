# AMO listed release

This directory contains the metadata and release checklist for the public addons.mozilla.org listing of **Zamery Browser Companion**.

Current public AMO version: `0.2.6` (companion protocol 2) with stable Gecko ID `zamery-browser-firefox@zamery.local`. It is public at https://addons.mozilla.org/firefox/addon/f82d5bdb37964220aafe/ (AMO version `6548018`, file `5092157`). The accepted XPI SHA-256 is `7d3d2a57c464f8ccc6f1ea3edc2612071c6250057990f34f876b8d8b15d69ee0`; the matching production-source SHA-256 is `b1bc98035f49ccc3af55a9864bb9f5c7cf4c93cafc9525abb0579cc2bf5002b9`.

## Version history relevant to this release

`0.2.3` made the branded Companion public. `0.2.4` was a transient branding source candidate and was not promoted. `0.2.5` incorporates the cooperative background-control fix and is the accepted Companion for Zamery Browser `v0.2.3`.

The agent-action-overlay lane has now rebased on that immutable `0.2.5` release and uses Companion `0.2.6`. The `0.2.6` candidate adds advisory exact-target action cues plus capture suppression while keeping native wire protocol 2 and BrowserProvider V2 unchanged. It is Mozilla-signed/public as AMO version `6548018`, file `5092157`; the signed XPI SHA-256 is `7d3d2a57c464f8ccc6f1ea3edc2612071c6250057990f34f876b8d8b15d69ee0`.

## Production source boundary

Only these files belong in the production submission:

The file set is derived from `manifest.json` by `scripts/firefox-amo-listed.sh` (background scripts, content scripts, popup page and script, and the manifest itself), so it cannot drift from what the extension loads. Today that is:

- `asset-discovery-v1.js`
- `asset-transfer-v1.js`
- `agent-presence.js`
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

Listed submissions use `metadata-listed.json` and channel `listed`.

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

Companion `0.2.6` is the accepted browser artifact for stable Zamery Browser `v0.2.4`. It passes the source gate (`pnpm verify`, live Firefox 31/31, AMO lint 0 errors / 0 warnings / 0 notices), exact signed-XPI/source verification, signed real-profile acceptance, and clean-distribution acceptance. Production-source SHA-256 is `b1bc98035f49ccc3af55a9864bb9f5c7cf4c93cafc9525abb0579cc2bf5002b9`; signed XPI SHA-256 is `7d3d2a57c464f8ccc6f1ea3edc2612071c6250057990f34f876b8d8b15d69ee0`.
