# Technical preview status

Date: 2026-10-06. Scope: macOS, local stdio MCP (Codex and other local MCP hosts), desktop Firefox ≥ 142, DOM-synthetic input, no private-window control.

## Verdict

**Attention/auth UX release candidate accepted with an explicit clean-machine waiver.** The exact npm RC tuple is published under `preview`; companion `0.2.2` is Mozilla-signed and source-compatible with the accepted tree; signed real-profile attention/auth UX acceptance passed on Firefox 157. The clean-machine macOS gate was explicitly waived by the operator on 2026-10-06 (`WAIVED_BY_OPERATOR_2026-10-06`). This is a release exception, not a PASS: community users should treat clean-machine installation as unverified until it is measured separately.

## What exists (by layer)

| Layer | Evidence |
| --- | --- |
| Unit (policy: duration bounds, consent lifecycle, scope evaluation, control state machine) | `packages/browser-firefox/test/policy.test.mjs` |
| Real native-host process (journal privacy/migration/horizon/lock, coalescing, mutation status, protocol gate) | `test/native-host.test.mjs` — real `native-host.mjs` + native-messaging framing + UDS |
| Companion in a VM against fake Firefox APIs (authorization scope, replay/revoke, restart/rebind, control, groups, tabs, screenshots, artifacts) | `test/companion.test.mjs`, `groups-and-tabs.test.mjs`, `artifacts.test.mjs` |
| Content script in jsdom (snapshot privacy, credential fields, readable text) | `test/content-snapshot.test.mjs`; popup states: `test/popup.test.mjs` |
| Full stack: provider → UDS broker → real host → real companion code → fake browser | `test/provider-stack.test.mjs`, `provider-artifacts.test.mjs`, `doctor.test.mjs` |
| MCP: tool contract, in-process full stack, spawned stdio server, child-crash recovery, clean exit | `packages/browser-mcp/test/*.test.mjs` |
| **Live real Firefox 157** (isolated temp profile, headless, own host name + extension id) | `packages/browser-mcp/live/live.test.mjs`; baseline evidence `docs/evidence/live-firefox-2026-10-05.json`; background-control evidence `docs/evidence/live-firefox-background-2026-10-06.json` |
| **Real authenticated Firefox profile** | Signed companion `0.2.2` on `default-release`; rebind stayed user-controlled; attention requested/deduped before access; explicit Share bound the grant; Manage Access reduced a three-tab scope to two and the removed Facebook tab immediately became `outside_scope` while Zamery Center stayed usable. Evidence: `docs/evidence/attention-auth-ux-pre-release-2026-10-06.json`. |
| Packaging | `pnpm pack` of the three packages, installed in an empty project: `zamery-browser-firefox setup/doctor` and `zamery-browser-mcp` start (initialize ≈ 1 s) |
| Lint of the production companion | `web-ext lint` on the staged source: 0 errors / 0 warnings |

`pnpm verify` (build + typecheck + test) is green; CI runs the same.

The attention/auth UX source passed the current live Firefox suite 24/24 and AMO lint with 0 errors / 0 warnings. The exact signed `0.2.2` XPI was then verified with `pnpm release:tuple --xpi` and accepted on the real authenticated Firefox profile. Current release evidence: `docs/evidence/attention-auth-ux-pre-release-2026-10-06.json`.

## Acceptance matrix (section 18 of the validation review)

Legend: ✅ proven at the named layer · 🟡 partly proven · ❌ not proven (blocked on something listed below) · WAIVED = explicitly skipped by operator and not claimed as proven.

| # | Scenario | Status | Evidence / what is missing |
| --- | --- | --- | --- |
| 1 | Clean macOS install from published pinned packages + signed XPI | WAIVED | `WAIVED_BY_OPERATOR_2026-10-06`. This gate was intentionally skipped for this operator-authorized preview release. No clean-machine PASS is claimed. |
| 2 | Existing authenticated Firefox, no relaunch/cookie export; unrelated tab inaccessible | ✅ | Signed companion `0.2.2` on the user's `default-release` profile preserved the authenticated session. After explicit user Share and then shrink-only Manage Access, the removed Facebook tab failed immediately with `BROWSER_AUTHORIZATION_REQUIRED / outside_scope` while the two Zamery Center tabs remained usable. Evidence: `docs/evidence/attention-auth-ux-pre-release-2026-10-06.json`. |
| 3 | Single-tab grant: other tab ids, snapshot, image, asset, cached ids, titles/URLs, direct broker access denied | ✅ | Live + companion + full-stack. |
| 4 | Group grant/read/write: snapshot default, opt-in follow, joins/leaves, last-member removal, recreate, cross-window, pinned/split | 🟡 | Live: snapshot default, late joiner, leave/re-enter, structural protection, create/update/move/activate/remove, last-member deletion. VM: follow_group, recreate with same id/title, pinned refusal, cross-window refusal. Not live: follow_group, cross-window, split view. |
| 5 | Duration: session, presets, custom bounds, exact deadline; expiry/revoke in queued request and active transfer; restart + rebind | ✅ | Unit bounds; companion expiry/clock-regression/queued-write/mid-transfer revoke; live fixed 3-day grant survives extension reload and Firefox restart as `rebind_required` with the original deadline. |
| 6 | Restart / rebind semantics | ✅ | Live extension reload + Firefox restart. |
| 7 | Takeover/resume incl. MFA, manual click/navigation, SPA, focus switch, popup, background control, same-node edit | ✅ | Live: credential hand-off, **trusted** (Marionette-synthesized) key and click, manual navigation, SPA staleness, origin change, interactive tab switch, page popup not shared, plus explicit background mode acting on the exact shared tab while another tab remains foreground with no focus theft/retarget. Take over/Resume/revoke, credential refusal and origin confirmation were re-proven in background mode. Same-node edit detection is covered in the VM only (the interaction generation). Native OS dialogs/passkeys are out of scope. |
| 8 | Tab lifecycle: create/navigate/reload/close owned, user close refused, no duplicate create on recovery | ✅ | Live (repeat of the same request id opens one tab). |
| 9 | Screenshot + model vision | ✅ | Live: pixel-verified rect capture, bounded JPEG, expiry on revoke. The supported Codex configuration includes the shipped recipe, which makes Codex open the returned local image file before describing pixels; live Firefox + Codex 0.160.0 passed 3/3 with that recipe. Without it this bridge guessed incorrectly 0/2. DPR ≠ 1, scrolled-viewport and resize races remain coverage gaps rather than preview blockers. |
| 10 | MCP / native-host failure recovery | ✅ | MCP child SIGKILL → new child keeps the grant, observations fresh; host killed mid-action → `outcome_unknown`, secret never on disk; extension reload live. Codex-host restart recovery is not measured (it depends on the Codex surface). |
| 11 | Revoke during queued / read / transfer / mutation | ✅ | Companion VM + full-stack tests (queued write not dispatched, read discarded, mutation reports safe status, artifact dropped). |
| 12 | Typed/key/OTP/hidden canaries absent from journal/log/artifact metadata; legacy migration | ✅ | Host tests + live canary scan of the real journal, host log and artifact metadata. |
| 13 | Cached replay after revoke denied | ✅ | Companion VM (same-id snapshot replay after revoke is the reproduced F02 probe, now prevented). |
| 14 | Multi-client / profile isolation | 🟡 | Real host tests: audience isolation, per-profile journals, single-writer lock. Two simultaneous real Firefox profiles were not run. |
| 15 | Signed XPI/source compatibility | ✅ | Signed companion `0.2.2`, AMO version `6546104`, file `5090243`, SHA-256 `56acdbe5c6db19ce3c4d7567c652996cd895bde0b74700e266aec3710dd50aa9`. `pnpm release:tuple --xpi` verified manifest `0.2.2`, Mozilla signature presence, and exact companion source SHA-256 `3ed571fe4f4af7400b7ceb1bd27d8e67278d59b23b3f15ba497b425671457bbf`. |
| 16 | Mismatched protocol fails closed | ✅ | Host + companion VM + doctor tests; a protocol-1 companion with a protocol-2 host is rejected for every op but `status`. |

## Codex runs (real Codex CLI 0.160.0, MCP server over stdio)

Method: `codex exec` with the MCP server added only through `-c mcp_servers.…` overrides (the user's `~/.codex/config.toml` is untouched), against a fake-Firefox stack or the live isolated Firefox, asking the model to describe a screenshot whose four quadrants are red / blue / green / yellow.

1. **Inline MCP `ImageContent` only:** the tools ran and returned the image block, but the model answered *red, green, blue, yellow* — the classic guess, wrong for two quadrants. In this setup (Codex → local ChatGPT-web bridge) the inline image did not reach the model. A control with the same JPEG attached through `codex exec -i` was answered correctly, so the model itself can see images.
2. **Local file path in the tool result:** with `local_file=true`, Codex opened the file with its own image viewer and answered correctly (*red, blue, green, yellow*) — not the classic guess.
3. After that finding `browser_screenshot` returns both the inline image and a local file path by default (and, later, a first line telling the model to open the file before describing it). A fake-Firefox run with these defaults answered correctly once.
4. **Against the live isolated Firefox, with the shipped defaults and a neutral prompt, Codex answered the heading and URL correctly (from page text) but guessed the colours (*red, green, blue, yellow*) in two runs out of two** — it called `browser_artifact_read` but never opened the file with an image viewer. Only when the prompt itself told it to open the returned local file did it read the pixels. So the model-vision row **fails with default behaviour** on this Codex build/bridge; it is a host/model-behaviour limitation, not a Zamery capture bug (the captured pixels are verified in the live suite).

5. **With the Codex recipe** (`packages/browser-mcp/codex/AGENTS.snippet.md`, placed as `AGENTS.md` in the working directory of `codex exec`, neutral prompt, live isolated Firefox): *red, blue, green, yellow* — correct in 3 runs out of 3 (the model opened the returned file). The recipe is part of the supported Codex configuration for this preview and is shipped both as an AGENTS.md snippet and as `packages/browser-mcp/codex/skill/zamery-browser/SKILL.md`; it is not installed automatically.

Consequence: preview acceptance is tied to a tested **Codex surface/build + installed recipe** tuple. Inline MCP image forwarding is not required for this preview as long as the returned file path can be opened by the agent's image viewer. Other Codex surfaces/builds need their own visual-question acceptance before being advertised as supported.

## Release-candidate tuple

`pnpm release:tuple` prints the tuple for the working tree: git SHA (+ dirty flag), npm package versions, companion version and a hash of the exact files that would be staged for AMO, signed XPI SHA-256 (with `--xpi`), native wire protocol, BrowserProvider protocol, installed Firefox, Node, macOS build/arch and the Codex CLI. These are different numbers on purpose: package semver, companion version, wire protocol, MCP protocol and provider protocol move independently.

The previously accepted tuple used npm `@zamery/browser-provider@0.2.2-rc.1`, `@zamery/browser-firefox@0.2.1-rc.1`, `@zamery/browser-mcp@0.1.0-rc.2` and signed companion `0.2.0` (`f82d5bdb37964220aafe-0.2.0.xpi`, SHA-256 `956e4b8ef0d3b083e35375ec3a0d0c769cf125a3ae1e86fca87e67446e0a65c3`, source hash `f07ffd81cd9bd04788291c672007c188e5fe618843a1995fc8f076cdf063e56f`). Background automation changes provider/MCP contracts and companion runtime, so that tuple is now a historical baseline only.

Previous accepted background-control tuple: `@zamery/browser-provider@0.2.2-rc.2`, `@zamery/browser-firefox@0.2.1-rc.2`, `@zamery/browser-mcp@0.1.0-rc.3`, companion `0.2.1`, native wire 2, BrowserProvider protocol 2, journal schema 2. Those npm RCs were published under dist-tag `preview`, fresh-registry smoke passed, and the signed XPI/source tuple was verified. Durable historical evidence: `docs/evidence/background-release-2026-10-06.json`.

Attention/auth UX accepted tuple: `@zamery/browser-provider@0.2.2-rc.3`, `@zamery/browser-firefox@0.2.1-rc.3`, `@zamery/browser-mcp@0.1.0-rc.4`, companion `0.2.2`. It adds provider-neutral access attention, toolbar/optional notification UX, bounded MCP `browser_request_access`, user-only notification navigation, and shrink-only Manage Access. The exact npm RC tuple is published under dist-tag `preview`, fresh-registry smoke passes, the Mozilla-signed XPI/source tuple is verified, and real authenticated-profile attention/auth UX acceptance passes. Durable evidence: `docs/evidence/attention-auth-ux-pre-release-2026-10-06.json`.

## What blocks GO

No remaining release gate is open for this operator-authorized preview candidate. The clean-machine macOS gate was explicitly waived on 2026-10-06; that exception does not convert the gate into a PASS.

## Known limitations of the preview scope

- Detection of human activity is best-effort: trusted gestures on the claimed tab, manual navigation and credential fields are detected in both control modes; tab/window switches hand control to the user in `interactive` mode but are intentionally ignored in explicit `background` mode. OS-level dialogs and some gestures are not detected. The panel's *Take over* is authoritative.
- Only the top frame is snapshotted; iframes, closed shadow roots, console/network capture, downloads/uploads, native choosers and passkeys are not covered. Containers: the partition is recorded when Firefox exposes `cookieStoreId` (it requires the `cookies` permission, which is deliberately not requested), otherwise it is unknown.
- `tabs.captureTab` has no abort; the encoded-size limit is enforced after Firefox has produced the data URL.
- The consumer id is a routing key, not an authenticated identity (same-OS-user trust boundary).
- A page-opened popup is never auto-shared; the user shares it explicitly.
- OS notifications are optional. If permission is absent/revoked or Firefox cannot open the popup from a notification click, the toolbar badge remains the fallback and the user opens the panel manually.

## Deferred (P2/P3, not part of the preview)

Bounded console/network observation, iframe and open-shadow traversal, download observation and upload, container UX, an external group/tab event stream, evidence bundles, WebDriver BiDi / OS-level input, native chooser/clipboard/dialog control, video/performance, and a standard WebMCP bridge.
