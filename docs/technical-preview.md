# Technical preview status

Date: 2026-10-05. Scope: macOS, local stdio MCP (Codex and other local MCP hosts), desktop Firefox ≥ 142, DOM-synthetic input, no private-window control.

## Verdict

**Not a technical preview yet (NO-GO to publish).** The implementation of P0 and almost all of P1 exists and is covered by tests at every layer, including a live run against a real Firefox 157. What is *missing* is evidence that only a signed artifact and other machines can provide: a Mozilla-signed protocol-2 companion, a clean-machine install of the published tarballs, and a run against a real, already-authenticated Firefox profile. Do not publish npm packages or an XPI, and do not tell users to install this, until those rows pass for one release-candidate tuple.

## What exists (by layer)

| Layer | Evidence |
| --- | --- |
| Unit (policy: duration bounds, consent lifecycle, scope evaluation, control state machine) | `packages/browser-firefox/test/policy.test.mjs` |
| Real native-host process (journal privacy/migration/horizon/lock, coalescing, mutation status, protocol gate) | `test/native-host.test.mjs` — real `native-host.mjs` + native-messaging framing + UDS |
| Companion in a VM against fake Firefox APIs (authorization scope, replay/revoke, restart/rebind, control, groups, tabs, screenshots, artifacts) | `test/companion.test.mjs`, `groups-and-tabs.test.mjs`, `artifacts.test.mjs` |
| Content script in jsdom (snapshot privacy, credential fields, readable text) | `test/content-snapshot.test.mjs`; popup states: `test/popup.test.mjs` |
| Full stack: provider → UDS broker → real host → real companion code → fake browser | `test/provider-stack.test.mjs`, `provider-artifacts.test.mjs`, `doctor.test.mjs` |
| MCP: tool contract, in-process full stack, spawned stdio server, child-crash recovery, clean exit | `packages/browser-mcp/test/*.test.mjs` |
| **Live real Firefox 157** (isolated temp profile, headless, own host name + extension id) | `packages/browser-mcp/live/live.test.mjs`; evidence `docs/evidence/live-firefox-2026-10-05.json` |
| Packaging | `pnpm pack` of the three packages, installed in an empty project: `zamery-browser-firefox setup/doctor` and `zamery-browser-mcp` start (initialize ≈ 1 s) |
| Lint of the production companion | `web-ext lint` on the staged source: 0 errors / 0 warnings |

`pnpm verify` (build + typecheck + test) is green; CI runs the same.

## Acceptance matrix (section 18 of the validation review)

Legend: ✅ proven at the named layer · 🟡 partly proven · ❌ not proven (blocked on something listed below).

| # | Scenario | Status | Evidence / what is missing |
| --- | --- | --- | --- |
| 1 | Clean macOS install from published pinned packages + signed XPI | ❌ | Only a temp-prefix install of locally packed tarballs was done. Needs a clean machine, published packages and a signed XPI. |
| 2 | Existing authenticated Firefox, no relaunch/cookie export; unrelated tab inaccessible | 🟡 | Live run used a throw-away profile (no real login). Unshared-tab isolation is ✅ live. Needs the user's own profile with the signed companion. |
| 3 | Single-tab grant: other tab ids, snapshot, image, asset, cached ids, titles/URLs, direct broker access denied | ✅ | Live + companion + full-stack. |
| 4 | Group grant/read/write: snapshot default, opt-in follow, joins/leaves, last-member removal, recreate, cross-window, pinned/split | 🟡 | Live: snapshot default, late joiner, leave/re-enter, structural protection, create/update/move/activate/remove, last-member deletion. VM: follow_group, recreate with same id/title, pinned refusal, cross-window refusal. Not live: follow_group, cross-window, split view. |
| 5 | Duration: session, presets, custom bounds, exact deadline; expiry/revoke in queued request and active transfer; restart + rebind | ✅ | Unit bounds; companion expiry/clock-regression/queued-write/mid-transfer revoke; live fixed 3-day grant survives extension reload and Firefox restart as `rebind_required` with the original deadline. |
| 6 | Restart / rebind semantics | ✅ | Live extension reload + Firefox restart. |
| 7 | Takeover/resume incl. MFA, manual click/navigation, SPA, focus switch, popup, same-node edit | ✅ | Live: credential hand-off, **trusted** (Marionette-synthesized) key and click, manual navigation, SPA staleness, origin change, tab switch, page popup not shared. Same-node edit detection covered in the VM only (the interaction generation). Native OS dialogs/passkeys are out of scope. |
| 8 | Tab lifecycle: create/navigate/reload/close owned, user close refused, no duplicate create on recovery | ✅ | Live (repeat of the same request id opens one tab). |
| 9 | Screenshot + model vision | ❌ | Live: pixel-verified rect capture, bounded JPEG, expiry on revoke. Real Codex 0.160.0 read a screenshot correctly through a **local file path** in a fake-Firefox run; an **inline MCP image block did not reach the model** in this user's setup (see below). Live-Firefox + Codex with default behaviour: wrong answer 2/2 (see "Codex runs"). DPR ≠ 1, scrolled-viewport and resize races not live-tested (headless DPR is 1). |
| 10 | MCP / native-host failure recovery | ✅ | MCP child SIGKILL → new child keeps the grant, observations fresh; host killed mid-action → `outcome_unknown`, secret never on disk; extension reload live. Codex-host restart recovery is not measured (it depends on the Codex surface). |
| 11 | Revoke during queued / read / transfer / mutation | ✅ | Companion VM + full-stack tests (queued write not dispatched, read discarded, mutation reports safe status, artifact dropped). |
| 12 | Typed/key/OTP/hidden canaries absent from journal/log/artifact metadata; legacy migration | ✅ | Host tests + live canary scan of the real journal, host log and artifact metadata. |
| 13 | Cached replay after revoke denied | ✅ | Companion VM (same-id snapshot replay after revoke is the reproduced F02 probe, now prevented). |
| 14 | Multi-client / profile isolation | 🟡 | Real host tests: audience isolation, per-profile journals, single-writer lock. Two simultaneous real Firefox profiles were not run. |
| 15 | Signed XPI/source compatibility | ❌ | No signed protocol-2 XPI exists. `pnpm release:tuple --xpi <file>` records its SHA-256 and verifies a Mozilla signature entry when one is supplied. |
| 16 | Mismatched protocol fails closed | ✅ | Host + companion VM + doctor tests; a protocol-1 companion with a protocol-2 host is rejected for every op but `status`. |

## Codex runs (real Codex CLI 0.160.0, MCP server over stdio)

Method: `codex exec` with the MCP server added only through `-c mcp_servers.…` overrides (the user's `~/.codex/config.toml` is untouched), against a fake-Firefox stack or the live isolated Firefox, asking the model to describe a screenshot whose four quadrants are red / blue / green / yellow.

1. **Inline MCP `ImageContent` only:** the tools ran and returned the image block, but the model answered *red, green, blue, yellow* — the classic guess, wrong for two quadrants. In this setup (Codex → local ChatGPT-web bridge) the inline image did not reach the model. A control with the same JPEG attached through `codex exec -i` was answered correctly, so the model itself can see images.
2. **Local file path in the tool result:** with `local_file=true`, Codex opened the file with its own image viewer and answered correctly (*red, blue, green, yellow*) — not the classic guess.
3. After that finding `browser_screenshot` returns both the inline image and a local file path by default (and, later, a first line telling the model to open the file before describing it). A fake-Firefox run with these defaults answered correctly once.
4. **Against the live isolated Firefox, with the shipped defaults and a neutral prompt, Codex answered the heading and URL correctly (from page text) but guessed the colours (*red, green, blue, yellow*) in two runs out of two** — it called `browser_artifact_read` but never opened the file with an image viewer. Only when the prompt itself told it to open the returned local file did it read the pixels. So the model-vision acceptance row **fails** for this Codex build/bridge with default behaviour; it is a host/model-behaviour limitation, not a Zamery capture bug (the captured pixels are verified in the live suite).

Consequence: do not rely on inline MCP images alone for a given host/bridge, and do not claim model vision for a Codex surface/build until the visual-question run passes there with the shipped defaults. Candidate follow-ups: a host-specific recipe in the setup docs (prompt/skill telling the agent to open the returned file), or testing other Codex surfaces/builds that forward MCP image blocks.

## Release-candidate tuple

`pnpm release:tuple` prints the tuple for the working tree: git SHA (+ dirty flag), npm package versions, companion version and a hash of the exact files that would be staged for AMO, signed XPI SHA-256 (with `--xpi`), native wire protocol, BrowserProvider protocol, installed Firefox, Node, macOS build/arch and the Codex CLI. These are different numbers on purpose: package semver, companion version, wire protocol, MCP protocol and provider protocol move independently.

Current source tuple (unsigned): packages provider 0.2.0 / firefox 0.2.0 / mcp 0.1.0 / pi 0.2.0; companion 0.2.0 (protocol 2; the distributed signed companion is 0.1.x, protocol 1); native wire 2; journal schema 2. No signed XPI, no published npm artifacts.

## What blocks GO

1. A Mozilla-signed protocol-2 companion (AMO credentials are not available in this environment).
2. A clean-machine install of the published, pinned artifacts (Node/Firefox/Codex versions recorded in the tuple).
3. A run against the user's real, already-authenticated Firefox profile with the signed companion.
4. A tested Codex surface/build where the screenshot visual question passes with the shipped tool defaults (currently failing, see above).

## Known limitations of the preview scope

- Detection of human activity is best-effort: trusted gestures on the claimed tab, tab/window switches, manual navigation and credential fields are detected; OS-level dialogs and some gestures are not. The panel's *Take over* is authoritative.
- Only the top frame is snapshotted; iframes, closed shadow roots, console/network capture, downloads/uploads, native choosers and passkeys are not covered. Containers: the partition is recorded when Firefox exposes `cookieStoreId` (it requires the `cookies` permission, which is deliberately not requested), otherwise it is unknown.
- `tabs.captureTab` has no abort; the encoded-size limit is enforced after Firefox has produced the data URL.
- The consumer id is a routing key, not an authenticated identity (same-OS-user trust boundary).
- A page-opened popup is never auto-shared; the user shares it explicitly.

## Deferred (P2/P3, not part of the preview)

Bounded console/network observation, iframe and open-shadow traversal, download observation and upload, container UX, an external group/tab event stream, evidence bundles, WebDriver BiDi / OS-level input, native chooser/clipboard/dialog control, video/performance, and a standard WebMCP bridge.
