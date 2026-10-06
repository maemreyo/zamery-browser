# Firefox agent action overlay — MVP implementation plan

Status: **MVP source implementation and live acceptance complete on `codex/firefox-agent-action-overlay`; rebased onto current `main` and prepared as unsigned Companion `0.2.6`.**

Current acceptance evidence on 2026-10-06: `@zamery/browser-firefox` 232/232 tests PASS, including regressions for revoke and origin change during the final pre-capture presence sync, stale presentation sync/clear ordering, document-bound clear messages, and a real action dispatch while capture suppression is pending. Live isolated Firefox 157 acceptance is 31/31 PASS after rebasing on the stable background-control work. It covers overlay off/on outcome equivalence; fixed click/fill/type/key labels with no payload exposure; unsupported-target no-cue behavior; nested-scroll and real browser-zoom geometry tracking; replacement non-retargeting; Take over/Resume/revoke cleanup; a deterministically forced reduced-motion branch; presentation-animation fault isolation; and an actual modal top-layer observation that records the visibility limitation without claiming guaranteed topmost rendering. Screenshot evidence remains: 1,941 overlay-colored pixels in the raw foreground probe, 0 in the product screenshot, clean background capture without focus theft, and 0 overlay pixels when a new `browser_fill` dispatches while capture suppression is pending. Release-wide `pnpm verify` also passes. AMO preflight passes with 0 errors, warnings, or notices and stages Companion `0.2.6` source SHA-256 `b1bc98035f49ccc3af55a9864bb9f5c7cf4c93cafc9525abb0579cc2bf5002b9`. Durable live evidence: `docs/evidence/live-firefox-agent-action-overlay-2026-10-06.json`. No signed XPI/publication claim is made by this plan.

Release integration reconciled against `origin/main` `1bd72819d055c0b10df606a95cc87c17f5c09b3c` on 2026-10-06. Stable Companion `0.2.5` is already immutable/public for Zamery Browser `v0.2.3`, so this overlay release candidate uses Companion `0.2.6` and `@zamery/browser-firefox@0.2.3` under root release `v0.2.4`. BrowserProvider V2 remains unchanged. This slice adds presentation behavior inside the Firefox Companion only.

## 1. Goal

Make agent browser actions visibly attributable to the agent while preserving the existing automation, authorization and receipt semantics.

The MVP provides:

- a short-lived ring around the exact DOM element already resolved for `click`, `fill`, `type` or `key`;
- a short label containing only the action class, for example `AI · click`;
- a user-controlled Companion setting to enable or disable action overlays;
- immediate cleanup on takeover, revoke, expiry, rebind/document invalidation and setting disable;
- screenshot suppression with an acknowledgement before `captureTab`, including actions that occur while a capture is in progress;
- reduced-motion behavior without an animation dependency.

The extension popup remains authoritative for grant/control state and Take over/Resume. The in-page overlay is advisory presentation only. It does not prove that an application operation, save, network request or business workflow succeeded.

## 2. Non-goals

The MVP does not add:

- a public BrowserProvider API or BrowserProvider V3;
- a new agent permission or authority path;
- ghost cursor or simulated pointer travel;
- pre-action preview or deliberate action delay;
- replay/timeline recording;
- iframe highlighting beyond the currently supported action target (`frame 0`);
- native-input visualization;
- business-success labels such as `Saved` or `Submitted`;
- WebMCP/application-command-to-DOM inference when no DOM target exists;
- an animation package, bundler or minification step.

If later requirements need timeline sequences, spring choreography, native cursor motion or replay, evaluate animation libraries against those concrete requirements at that time. Do not preselect Motion Mini or another package for this MVP.

## 3. Hard invariants

### 3.1 Overlay cannot change action outcome

The action path must never await overlay animation, timers, cleanup or positioning work.

`showAction()` is a best-effort, synchronous trigger that returns `void`. Its implementation contains its own error isolation. Any failure to create a host, calculate a rectangle, start WAAPI, schedule a frame, observe a node or clean up must be swallowed inside the presentation layer and must not change:

- whether the DOM action is dispatched;
- the content-script action result;
- background `completed` / `not_started` / `partially_applied` / `outcome_unknown` semantics;
- mutation receipt contents;
- takeover behavior for a genuinely unknown dispatched action.

No code after a DOM mutation may await `animation.finished`. If a future implementation consumes that promise, it must handle rejection caused by `cancel()` internally.

### 3.2 No pre-action delay

The MVP does not wait for `requestAnimationFrame`, animation visibility or a timer before mutating the target. The visual cue may begin in the same task immediately before the DOM mutation or become visible on the next paint; it is never a promise that the user can intervene between preview and dispatch.

This preserves the existing background action-time authority and claim rechecks immediately before dispatch.

### 3.3 Presentation never becomes authority

The overlay must not decide whether an action is allowed. Grant, scope, claim, focus/control mode, document freshness, credential refusal, revoke/expiry and mutation recovery remain owned by the current Companion policy/background path.

Closed Shadow DOM may be used to isolate CSS, but it is not a security boundary. A page can remove, cover or imitate in-page UI. The popup remains the trusted place for Take over/Resume and grant state.

### 3.4 Overlay contains no action payload

Presentation state may contain:

- action class: `click | fill | type | key`;
- opaque internal generation/token identifiers;
- DOM geometry and timestamps needed for rendering.

It must not contain or persist:

- `fill` value;
- typed text;
- actual key value;
- page title/URL in the label;
- agent-authored reason/note;
- arbitrary page text;
- application/business result text.

The visible labels are fixed extension strings only: `AI · click`, `AI · fill`, `AI · type`, `AI · key`.

## 4. Ownership and integration points

### Content script: target and presentation owner

Add a small internal presentation module, preferably `runtime/companion/agent-presence.js`, loaded before `content.js` in production and development manifests.

The content script already resolves the exact node and validates document identity before action. `act()` passes that exact `Element` to the presentation module only inside the selected action branch, after all synchronous checks that can still reject that action as unsupported and immediately before the first effectful DOM operation. It does not query the page a second time to rediscover a target.

Conceptually:

```text
resolveNode(ref)
  -> credential/ref checks
  -> choose action branch
  -> branch-specific unsupported checks
  -> safeShowAction(element, action)     # fire-and-forget presentation
  -> first existing effectful DOM step  # unchanged outcome semantics
  -> return existing action result
```

The presentation call is isolated from the action with an internal `try/catch`; asynchronous presentation callbacks also isolate their own errors.

Examples of the placement rule:

- `click`: cue immediately before the existing click dispatch;
- `fill`: first prove the element is an input/textarea/contenteditable target, then cue immediately before the value/text mutation;
- `type`: reject unsupported contenteditable/non-text targets first, then cue immediately before focus/text mutation;
- `key`: complete existing request/target validation first, then cue immediately before focus/key dispatch.

An action that returns `not_started` because its target semantics are unsupported must not emit an action cue.

### Background: control lifecycle and screenshot coordinator

`background.js` remains authoritative for grant/claim lineage. It sends narrow internal messages to the claimed/shared document when control state invalidates presentation:

- `scope_sync` / equivalent on a new valid grant/claim generation;
- `clear` on Take over, revoke, expiry, rebind and invalidating document/control transitions;
- setting changes that disable the overlay;
- screenshot `suppress` and idempotent `release` coordination.

These are internal Companion messages, not BrowserProvider capabilities.

`actOnContext()` retains its current authorization and dispatch order. No presentation call is inserted between the final authority check and `sendMessage(...act...)` that can await or fail the dispatch.

### Popup: trusted control UI and preference owner

Add a Companion preference such as **Show agent actions on page**.

- Store it as extension-local presentation preference, separate from grant authority.
- Default: enabled for agent action cues unless product review chooses otherwise before release.
- Disabling it immediately clears current in-page presentation and prevents old callbacks from restoring it.
- Enabling it does not resurrect an expired action cue.

Take over/Resume and grant state continue to use existing popup control state. Any in-page claim indicator is secondary and may be omitted from the first implementation if it complicates lifecycle acceptance.

## 5. Presentation lifecycle model

The module owns one current action cue per document and a set of screenshot suppression tokens.

### 5.1 Separate identities and generations

Do not use one generation for document identity, control lifecycle, action cleanup and screenshot suppression. Keep four concepts separate:

```text
DocumentIdentity
  documentId / browserDocumentId

ControlRevision
  grantId / grantRevision
  claimGeneration

ActionGeneration
  local monotonically increasing cue generation

CaptureToken
  opaque unique token
  documentIdentity
  issuedAt
  expiresAt
```

`ActionGeneration` monotonically increases on clear/disable/new action/control-scope replacement. Every timer, rAF callback, observer callback and animation cleanup captures the action generation that created it and exits without changing current UI when that generation is stale.

This prevents an old animation's completion/cleanup callback from deleting a newer action ring.

`CaptureToken` is intentionally independent of `ControlRevision` and `ActionGeneration`. A takeover/resume or a new action generation in the same document does not release screenshot suppression. A capture token is released only by its idempotent release/expiry lifecycle or by destruction of that document.

### 5.2 Action cue

`showAction(element, action)`:

1. returns immediately if disabled, suppressed, target is disconnected or the current scope is invalid;
2. increments the local action generation;
3. updates/creates a non-interactive overlay host and ring for the supplied `Element`;
4. starts positioning and expiry work scoped to that generation;
5. starts WAAPI opacity/scale animation when reduced motion is not requested;
6. never returns an animation promise to the action path.

Base CSS keeps the ring/label `opacity: 0`. WAAPI supplies temporary visible opacity. When animation ends or is cancelled, base CSS remains hidden even if cleanup is delayed.

### 5.3 Clear

`clear(reason)` must do more than `Animation.cancel()`:

- increment generation first;
- cancel the current `Animation` if present;
- cancel `requestAnimationFrame` work;
- clear expiry timers;
- disconnect any observer used by the implementation;
- remove or hide ring/label nodes;
- drop target references;
- leave screenshot suppression tokens governed by their own token lifecycle;
- never throw into the caller.

Takeover/revoke/expiry/rebind/document invalidation and setting disable call `clear()`.

### 5.4 Reduced motion

Check `matchMedia('(prefers-reduced-motion: reduce)')` in JavaScript.

When active:

- do not start the pulse/scale WAAPI sequence;
- show a static ring/label for a bounded short lifetime;
- use the same generation-safe cleanup path.

Preference changes while a cue is visible may clear and redraw under a new generation; they must not alter the action result.

## 6. DOM and accessibility rules

Use one extension-owned overlay host per document. A closed Shadow DOM is acceptable for CSS isolation, with these constraints:

- host and descendants use `pointer-events: none`;
- no `button`, `a`, form control or other focusable element exists in the overlay;
- do not add a positive or zero `tabindex`;
- mark presentation as `aria-hidden="true"`;
- never call `focus()`, `scrollIntoView()` or mutate target attributes/styles/classes;
- do not prevent page events;
- do not use the overlay for user interaction.

The host/wrapper owns position. The animated ring child owns opacity/scale. Do not use the same `transform` property for both target positioning and the pulse animation.

Top-layer elements such as fullscreen/dialog UI can appear above ordinary document stacking contexts. The product must not promise that the ring is visible above every browser/page surface.

## 7. Positioning and stale-target behavior

The action target is the exact resolved `Element` in the current top document.

While a cue is alive:

- derive geometry from `getBoundingClientRect()`;
- render using viewport/fixed coordinates;
- update geometry through a bounded rAF loop for the cue lifetime so scroll, zoom/layout movement and nested scrolling are followed without introducing action delay;
- if the target becomes disconnected or leaves the current document, clear that generation;
- do not substitute a replacement element based on selector/text similarity;
- do not auto-scroll to make the target visible;
- clipping or an offscreen target may result in no visible ring; that is preferable to changing page state.

Current action refs require `frame 0`, so MVP acceptance covers only the top frame. All-frame content-script injection does not imply iframe action-highlight support.

## 8. Screenshot suppression protocol

Screenshot artifacts should describe the page, not the transient agent-action presentation. Suppression is therefore the one presentation path that `captureScreenshot()` may await before capture.

### 8.1 Token semantics

Use opaque suppression tokens, not a single boolean.

Content-side state:

```text
suppressionTokens: Map<token, {
  documentIdentity,
  issuedAt,
  expiresAt
}>
suppressed := suppressionTokens.size > 0
```

Rules:

- `suppress(token, expectedDocument)` is idempotent for the same token/document pair and rejects token reuse against another document;
- once accepted, the overlay is synchronously hidden/removed from presentation, and future `showAction()` calls remain visually suppressed while any unexpired token exists for that document;
- multiple captures/internal callers may hold independent tokens;
- an action that starts during capture may advance current action/control state, but remains invisible until suppression reaches zero;
- takeover/resume in the same document changes `ControlRevision` but does not remove capture tokens; a new action after resume is still suppressed while capture is active;
- `release(token, expectedDocument)` is idempotent and removes only that token; it never restores an old cue or decrements action/control generations;
- a release for an old document cannot affect suppression or cues in the new document;
- when the final token leaves, presentation merely becomes eligible for *future* cues under the current control revision; no previous cue is replayed or resurrected;
- each token has a bounded expiry as recovery from lost acknowledgements/releases; expiry only releases suppression and never restores old cue state.

### 8.2 Render-settle barrier and acknowledgement

A content-message acknowledgement that CSS/DOM state changed is not, by itself, proof that Firefox has composited a new frame. The protocol therefore separates **suppression applied** from **capture may start**.

Use a two-stage acknowledgement so a synchronous DOM hide is never mislabeled as a paint barrier:

1. `suppress(token, expectedDocument)` installs the token, synchronously forces presentation to its hidden base state, detaches/hides any visible ring, performs a style/layout read, and returns only `suppression_applied`.
2. Background then asks `confirm_suppression(token, expectedDocument)` before starting `captureTab`.
3. For a visible document, `confirm_suppression` waits for two `requestAnimationFrame` callbacks, rechecks that the same token/document is still suppressed, then returns `paint_barrier: "foreground-double-raf"`.
4. For a hidden/background document, do not depend on rAF. The initial suppress response plus the separate confirmation request provides an extension/background/content task roundtrip; content rechecks that the host is hidden and the token is active, then returns `paint_barrier: "background-roundtrip-unproven"`.
5. Both confirmation paths use `OVERLAY_SUPPRESSION_BARRIER_TIMEOUT_MS = 1_000`. Missing that deadline fails the screenshot before `captureTab`.

Acknowledgements contain only internal state such as document identity, token, suppression-active status and barrier mode. They contain no page/action payload.

Release criteria for the MVP:

- foreground screenshot suppression must pass real Firefox pixel acceptance with an overlay visibly active immediately before suppression;
- background-tab screenshot suppression must pass a separate real Firefox pixel acceptance proving `captureTab` observes the suppressed state under the bounded roundtrip fallback;
- if background behavior cannot be demonstrated reliably on the supported Firefox release, the implementation must fail that background screenshot with a specific suppression-unverified error whenever an overlay could contaminate the capture. It must not silently claim the screenshot is clean.

No standards-level claim is made that rAF itself guarantees screenshot cleanliness. The live pixel gate is part of the product contract for this feature.

### 8.3 Capture flow and deadlines

Target flow in `captureScreenshot()`:

```text
authorize capture + establish lineage/document
  -> create capture token with document identity + absolute expiry
  -> send suppress(token, expected document)
  -> require suppression_applied acknowledgement
  -> confirm_suppression(token, expected document)
  -> require barrier acknowledgement before capture start
  -> re-authorize `capture` + require original lineage still current
  -> re-read target document and require same document identity/URL basis
  -> captureTab(...)
  -> existing authority/document revalidation
  -> if capture settles before caller deadline:
       keep/discard artifact according to existing rules
       release token idempotently for the same document
  -> if caller deadline wins while capture is still pending:
       fail caller + permanently disqualify late result
       keep token until underlying capture settles or hard-expiry
       release idempotently on settlement/expiry
```

If suppression cannot be acknowledged, fail the screenshot rather than claim the artifact is overlay-free. This failure does not affect browser mutation receipts.

The pre-dispatch recheck is mandatory because both suppression RPCs create an authorization/document race window. Immediately after the barrier acknowledgement and before invoking `captureTab`:

- require the original `lineage` to remain current;
- call `contextAuthorization(contextId, "capture")` again and require capture scope to remain granted for the same tab/context;
- ping/re-read the target document and require the same `document_id` plus the existing URL identity basis used by screenshot validation;
- if revoke, expiry, scope shrink, rebind or navigation/document replacement occurred while suppression was pending, fail before `captureTab` and release the token through the normal idempotent recovery path.

Explicit Take over by itself does not revoke `capture` authority under the current policy, so the screenshot path must not invent a claim requirement. If capture authorization, lineage and document identity remain valid, Take over alone may still allow capture. Any later policy change that makes capture claim-bound must be handled as a separate authorization-contract change.

Use three bounded clocks, with constants defined next to the existing screenshot limits:

- **suppression/barrier deadline**: `OVERLAY_SUPPRESSION_BARRIER_TIMEOUT_MS = 1_000` for each suppress/confirm content RPC;
- **capture result deadline**: existing `SHOT_CAPTURE_TIMEOUT_MS = 20_000`, visible to the caller;
- **suppression hard-expiry**: `OVERLAY_SUPPRESSION_HARD_EXPIRY_MS = 30_000`, measured from token issue, used only as recovery so a lost release cannot hide the overlay forever.

`captureTab()` currently has no AbortSignal and the existing timeout uses `Promise.race`, so caller timeout does not prove the underlying browser capture settled. Preserve the underlying capture promise separately:

- if capture settles before the caller deadline, finish the normal post-capture validation/artifact decision, then release the token on that settled path;
- if caller timeout wins, return/discard according to existing screenshot timeout semantics, but keep the token while the underlying capture is still pending;
- attach a settlement handler to the underlying capture promise that idempotently releases the token and discards any late pixels/result after caller timeout;
- if the browser capture never settles, content-side token hard-expiry eventually releases suppression; any later capture result is permanently ineligible for artifact publication;
- a lost suppress acknowledgement triggers an idempotent best-effort release of the same token before returning failure, while token expiry remains the final recovery path;
- a lost release message is recovered by bounded retry/idempotent release while the document is still reachable, then by token hard-expiry if delivery never succeeds. The initial implementation uses at most two additional release attempts within the hard-expiry window; retries do not extend token expiry.

The capture path must continue to apply its existing authorization, size, document-change, timeout and artifact rules. A late result after timeout can never re-enter the artifact path.

## 9. Failure isolation

Presentation failures are deliberately asymmetric:

| Failure | Action path | Screenshot path |
| --- | --- | --- |
| Host creation/CSS/WAAPI failure | Ignore; action proceeds | N/A unless suppression cannot be acknowledged |
| rAF/timer/observer failure | Ignore/clear best-effort | N/A |
| Old animation callback | Generation check; no effect | N/A |
| Overlay clear message fails because document disappeared | No mutation semantic change | Existing document validation decides screenshot result |
| Suppress acknowledgement missing | No mutation semantic change | Screenshot fails before `captureTab`; same token gets idempotent release attempt and bounded expiry |
| Release message/ACK lost | No mutation semantic change | Retry idempotently while document is reachable; token hard-expiry prevents indefinite suppression |
| Caller capture timeout while `captureTab` remains pending | No mutation semantic change | Result is already failed for caller; keep suppression until underlying promise settles or hard-expiry, and permanently discard late pixels |

No presentation exception may be translated into `BROWSER_ACTION_RESPONSE_LOST` or `MUTATION_OUTCOME_UNKNOWN`.

## 10. Implementation slices

Implement in a bounded worktree/branch and keep each slice reviewable.

### Slice A — presentation module and action integration

- Add `agent-presence.js` and load it before `content.js` in production/development manifests.
- Add presentation capability/version fields to content ping, for example `agent_presence_v1_ready: true` and `agent_presence_version: 1`; background must not infer readiness merely because `content.js` answered.
- Update every programmatic fallback path that injects `content.js` (`ensureContent()` plus asset discovery/transfer/A1 helper paths) so `agent-presence.js` is injected first or otherwise proven ready. Prefer a shared injection helper/order to prevent those paths drifting apart.
- Make `content.js` resolve the presentation helper dynamically at action time so a page that already has `content.js` can gain `agent-presence.js` through fallback injection without reinjecting a second content listener. Repeated helper injection must be idempotent.
- Add `agent-presence.js` to the fixed live-acceptance staging inventory in `live/stage-companion.mjs`. Keep the AMO path manifest-derived rather than adding a second manual AMO inventory.
- Implement generation-safe host/ring/label, WAAPI and reduced-motion fallback.
- Integrate `showAction()` with the exact resolved element in each action branch after unsupported-semantics checks and without awaiting it.
- Implement `clear()` and document-local tests.

Gate: deliberately throwing from every presentation entry/callback cannot alter action result/receipt behavior; stale/fallback-injected pages report presentation capability accurately; unsupported `fill`/`type` targets emit no cue.

### Slice B — control lifecycle and preference

- Add extension-local overlay preference to popup/background.
- Sync current presentation scope to the content document.
- Clear on Take over, revoke, expiry, rebind, invalidating navigation/document changes and preference disable.
- Ensure delayed callbacks from the old scope cannot redraw or remove current-scope UI.

Gate: takeover/revoke/disable visibly clears the cue and old callbacks cannot resurrect it.

### Slice C — screenshot suppression

- Add tokenized `suppress`, `confirm_suppression` and idempotent `release` internal messages with acknowledgements.
- Wrap `captureScreenshot()` with suppression before `captureTab` and release handling around all settlement paths.
- Bind capture tokens to document identity and independent expiry, not action/claim generation; takeover/resume in the same document leaves suppression active.
- Implement the foreground double-rAF barrier, background extension-roundtrip fallback/status, 1-second barrier deadlines, caller timeout vs underlying-capture settlement handling, idempotent release/retry and 30-second hard-expiry recovery.
- Make action cues created during capture remain hidden, including after takeover/resume and a new action generation.

Gate: concurrent action + screenshot fixtures produce an artifact without Zamery overlay pixels, including an action begun after suppression acknowledgement and before capture resolves; foreground and background cleanliness are proven by real Firefox pixel acceptance or the unsupported background case fails closed.

### Slice D — live Firefox acceptance and release evidence

- Run targeted automated suites.
- Run real Firefox acceptance with overlay on/off, scroll/zoom/replacement, takeover/revoke, screenshot concurrency and reduced motion.
- Update `security-model.md`, `technical-preview.md`, AMO source inventory/version evidence and release tuple only after source behavior is accepted.
- Sign/publish only under the repository's normal release gate; source changes alone are not signed-artifact evidence.

## 11. Focused automated verification

Add tests at the boundary each claim names.

### Content/presentation tests

1. `showAction` uses the exact resolved element and never re-queries by text/name.
2. `click`, `fill`, `type`, `key` expose only fixed action labels; payload/key text is absent from overlay DOM/state.
3. unsupported `fill` target and `type` on unsupported contenteditable return `not_started` without an action cue.
4. animation constructor/start throws -> existing action result remains unchanged.
5. async animation/rAF/timer callback throws -> no unhandled failure reaches the action response.
6. old generation cleanup cannot remove a newer ring.
7. `clear()` cancels animation/timer/rAF/observer and removes/hides presentation.
8. reduced motion uses static bounded cue and starts no WAAPI animation.
9. disconnected/replaced target clears; no replacement node is guessed.
10. scroll/resize/layout movement updates geometry without focus/scroll mutation.
11. overlay DOM contains no focusable controls and is `aria-hidden`/pointer-inert.
12. manifest-loaded, fallback-injected and live-staged content all report the same presentation capability/version; repeated helper injection is idempotent.

### Background/control tests

13. final authority/claim checks and action dispatch are unchanged by overlay enablement.
14. overlay on vs off produces the same mutation outcome and stable receipt semantics after normalizing controlled variable fields such as request IDs, observation timestamps and other clock/session-generated identifiers; compare action capability, mechanism/trust semantics, cancellation meaning and provider evidence fields that should be invariant.
15. Take over, revoke, expiry/rebind and invalidating document change clear current presentation.
16. stale clear/scope callbacks cannot affect a newer claim/action generation.
17. preference disable clears now; preference enable does not resurrect expired cue state.

### Screenshot tests

18. `captureTab` is not called until suppression/barrier acknowledgement succeeds.
19. revoke/expiry/scope shrink while `confirm_suppression` is pending makes the post-barrier lineage/authorization recheck fail and `captureTab` is never called.
20. navigation/document replacement while `confirm_suppression` is pending makes the post-barrier document recheck fail and `captureTab` is never called.
21. Take over alone, with capture authorization/lineage/document otherwise unchanged, does not introduce a new claim requirement into screenshot capture.
22. action cue created after suppression acknowledgement stays hidden through capture.
23. overlapping suppression tokens require all tokens to release/expire before presentation can become eligible again.
24. capture -> takeover -> resume -> new action in the same document remains suppressed until the capture token is released; release does not resurrect any pre-capture cue.
25. stale release token from an old document cannot affect suppression or reveal cues in the new document.
26. suppression acknowledgement loss triggers screenshot failure, idempotent release attempt and eventual expiry recovery.
27. release message/acknowledgement loss cannot leave suppression permanent; retry/expiry converges state.
28. caller timeout while the underlying `captureTab` promise resolves late keeps late pixels out of artifact publication and holds suppression until settlement or hard-expiry.
29. suppression failure never changes mutation status.
30. release handling covers successful capture, pre-dispatch authorization/document failure, timeout, post-capture document-change and artifact-validation failure without an unconditional early `finally` release.

Run the smallest affected Firefox Companion/provider tests; do not widen to unrelated packages unless an interface actually changes.

## 12. Live Firefox acceptance matrix

Use harmless fixture actions and compare recorded receipts/state, not only visual observation.

| Scenario | Required evidence |
| --- | --- |
| Overlay enabled vs disabled | Same target/outcome and normalized stable receipt semantics; variable IDs/timestamps controlled or canonicalized |
| Click/fill/type/key | Correct fixed label, exact target ring, no payload shown |
| Unsupported target | `not_started` with no action cue |
| Take over during/after cue | Cue disappears; callback does not resurrect it; writes remain governed by existing control policy |
| Revoke/expiry/rebind | Cue disappears and remains absent |
| Scroll/nested scroll/zoom | Ring tracks current rect without scrolling/focusing page |
| Target replacement | Old ring clears; replacement is not guessed/highlighted |
| Reduced motion | Static bounded cue, no pulse/scale animation |
| Forced WAAPI/presentation fault | Mutation receipt/outcome identical to overlay-off control |
| Screenshot while cue visible | Artifact contains no overlay |
| Action begins during suppressed capture | Artifact still contains no overlay |
| Capture -> Take over -> Resume -> new action -> capture settles | New action remains hidden until token release; no old cue is restored |
| Revoke/scope shrink during suppression confirmation | Post-barrier authorization/lineage recheck fails; `captureTab` is not called |
| Navigation during suppression confirmation | Post-barrier document recheck fails; `captureTab` is not called |
| Take over during suppression confirmation | Capture remains governed by capture scope/lineage/document policy; no synthetic claim gate is added |
| Suppress ACK lost | Screenshot fails cleanly and suppression converges by release/expiry |
| Release ACK lost | Suppression converges without waiting for a future scope event |
| `captureTab` resolves after caller timeout | Late result is discarded and cannot publish an artifact |
| Background-tab screenshot | Pixel fixture proves clean capture on supported Firefox, otherwise the operation fails closed as suppression-unverified |
| Fullscreen/dialog/top-layer | Record actual visibility limitation; do not claim guaranteed topmost rendering |

## 13. Acceptance gate

The MVP is accepted only when all of the following are demonstrated:

1. Overlay enabled and disabled produce the same browser mutation outcome and stable receipt semantics after controlling/canonicalizing expected variable IDs, clocks and session-derived fields.
2. No input value, typed text, key value or agent/page-authored reason is stored or displayed by the overlay.
3. Takeover/revoke/expiry/rebind/disable cleanup is generation-safe and stale callbacks cannot resurrect UI.
4. Screenshot suppression uses document-bound capture tokens independent of control/action generations, has a bounded render-settle protocol, covers actions and takeover/resume during capture, and converges under lost ACK/release and late-capture timeout paths.
5. After suppression/barrier acknowledgement and immediately before `captureTab`, capture authorization, original lineage and document identity are re-proven; revoke/scope shrink/navigation during that wait therefore prevent capture dispatch, while Take over alone does not invent a new capture-claim requirement.
6. Scroll/zoom/layout movement and node replacement do not cause the ring to target a different element.
7. Reduced-motion behavior is implemented in JS and verified.
8. Overlay/presentation faults cannot produce `outcome_unknown` or otherwise change an action result.
9. Live Firefox pixel acceptance proves foreground screenshot cleanliness and separately proves supported background-tab cleanliness; any unproven background case fails closed rather than publishing a possibly contaminated artifact.
10. One live Firefox run proves the user can see action attribution and still rely on Companion Take over/Resume as the authoritative control surface.

## 14. Delivery boundary

This is a Firefox Companion presentation feature. Keep BrowserProvider V2, provider receipts, authorization contracts and MCP tool semantics unchanged unless implementation uncovers a genuine contract gap. If such a gap appears, stop that expansion and review it separately rather than smuggling a public API change into the overlay slice.
