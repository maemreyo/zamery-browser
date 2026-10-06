# AMO listed release

This directory contains the metadata and release checklist for the public addons.mozilla.org listing of **Zamery Browser Companion**.

Current public AMO version: `0.2.5` (companion protocol 2) with stable Gecko ID `zamery-browser-firefox@zamery.local`. It is public at https://addons.mozilla.org/firefox/addon/f82d5bdb37964220aafe/ (AMO version `6547131`, file `5091270`). The accepted XPI SHA-256 is `8e89599e36fcec8d13c6da9d31cccf871626ce8b80d83e4345cd110eb8f8f59c`; the matching production-source SHA-256 is `a0a2f4624bcd4c49966d8ce683023a5cd7fccea1a99ee78af3841435438e6012`.

## Version history relevant to this release

`0.2.3` made the branded Companion public. `0.2.4` was a transient branding source candidate and was not promoted. `0.2.5` incorporates the cooperative background-control fix and is the accepted Companion for Zamery Browser `v0.2.3`.

The separate `codex/firefox-agent-action-overlay` development lane also used `0.2.5` while it was only an unsigned candidate. Because `0.2.5` is now an immutable public AMO release from `main`, that overlay lane must rebase on current `main` and use a new Companion version before any future submission.

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

Companion `0.2.5` is approved/public on AMO and is the accepted browser artifact for Zamery Browser `v0.2.3`. Exact XPI/source provenance, signed real-profile behavior and clean published-artifact acceptance are recorded in `docs/evidence/stable-release-v0.2.3-2026-10-06.json`.
