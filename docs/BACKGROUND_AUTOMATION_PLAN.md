# Background automation — fast implementation plan

Goal: let an explicitly shared Firefox tab/group keep running agent mutations while it is in the background, without stealing focus from the user. Keep the current focused-tab behavior as the safe default.

## Product contract

Add one explicit control mode to the existing grant:

- `interactive` (default): current behavior; writes require the claimed tab to be active in Firefox's focused window. A tab/window switch hands control to the user.
- `background`: user opts in from the Zamery Browser panel for the selected shared tab/group. Reads, screenshots and DOM mutations may continue on those exact shared contexts without activating them.

Background mode does **not** weaken the existing authority boundaries. Revoke/expiry, scope changes, credential/OTP/payment fields, private windows, unknown mutation outcomes, origin changes requiring confirmation, stale document/ref checks and explicit **Take over** still stop writes. It never retargets to the currently active tab.

## Implementation slice

### 1. Carry the mode through consent and status

- Add `control_mode: "interactive" | "background"` to the stored/live grant, defaulting old grants to `interactive`.
- Add a panel choice such as **Allow background control** with clear text that the selected shared tabs may be clicked/typed while not visible.
- Expose the active mode through `browser_status` so agents and receipts can prove which policy allowed a mutation.

### 2. Change only the dispatch guard

- Keep all current claim, grant, document, interaction-generation and action-time rechecks.
- Replace unconditional `requireFocusedTarget(tab)` with a mode-aware dispatch check:
  - `interactive` → require focused active target exactly as today.
  - `background` → require the exact claimed context to remain authorized/live; do not activate/focus it.
- A user's tab switch/window switch only triggers takeover for an `interactive` claim. In `background`, activity in another tab/window does not stop the worker.
- Human interaction or same-origin navigation inside the claimed background tab invalidates the old observation, but does not force a persistent handoff. The agent must take a fresh snapshot before its next write. Cross-origin navigation still requires user confirmation.

### 3. Preserve hard handoff boundaries

- Credential/OTP/payment field → refuse before dispatch and enter `user_control`.
- Manual navigation/origin change of the shared tab → withdraw mutation authority until confirmation under the existing origin policy.
- Panel **Take over** → stop queued/new writes immediately in both modes; **Resume** reacquires a fresh claim/snapshot.
- Revoke/expiry/rebind → unchanged.

## Focused verification

Add focused tests only for the new policy:

1. `interactive`: background-tab click still returns `claimed_tab_not_focused` (regression guard).
2. `background`: tab A is shared/claimed, user works in tab B, click/type on A succeeds without A becoming active.
3. Switching among unrelated tabs/windows does not end a background claim.
4. Human input in tab A invalidates the old observation and stops the agent.
5. Password/OTP refusal, origin-change confirmation, Take over, revoke and expiry behave identically in background mode.
6. Background mutation never leaks to or retargets an unshared active tab.

Run the smallest affected suites: companion policy/control tests, provider/MCP contract tests if the new status field crosses those boundaries, then one live Firefox acceptance.

## Live acceptance

Use two harmless tabs in the user's real Firefox:

1. Share tab A with **Background control**; keep tab B active.
2. Agent snapshots A, fills/clicks a harmless control, and verifies A changed while B remained active.
3. User continues interacting with B; agent performs a second harmless mutation on A.
4. User manually edits/navigates A → agent is blocked and needs explicit resume/confirmation.
5. Repeat one credential-field refusal and one **Take over → Resume** cycle.
6. Stop sharing → access disappears immediately.

Acceptance criterion: the agent can complete a multi-step flow on a shared background tab without focus stealing, while every existing security boundary above still fails closed.

## Delivery order

Implement in one bounded branch/worktree: contract + popup/status → companion dispatch policy → focused tests → live Firefox acceptance → update `security-model.md` and `technical-preview.md` with measured evidence. No provider redesign, BiDi, OS-input adapter or new browser abstraction is required for this slice.

## Implementation result — 2026-10-06

Implemented on `codex/background-automation` with two explicit modes carried through consent, popup, provider and MCP status/guidance:

- `interactive` remains the default for new, legacy and unknown grants; focused-tab behavior is unchanged.
- `background` is explicit opt-in and remains bound to the exact shared/claimed context. It does not activate the tab, steal focus, or retarget to an unrelated foreground tab.
- Rebind preserves the original control mode.
- Trusted interaction and same-origin manual navigation on the claimed tab make old observations stale without requiring Resume. Cross-origin changes, credentials/OTP/payment-like fields, explicit Take over, revoke/expiry/rebind, stale refs/documents and unknown mutation outcomes remain fail-closed.

Focused automated verification passed: `@zamery/browser-firefox` 197/197 tests and `@zamery/browser-mcp` 21/21 tests, with `@zamery/browser-provider` built first so downstream packages consumed the current contract.

The original real-Firefox acceptance passed 24/24 tests on Firefox 157.0 and is preserved as historical evidence in `docs/evidence/live-firefox-background-2026-10-06.json`. A follow-up real-Firefox acceptance for cooperative background control also passed: trusted human key and click events made old observations stale while the background claim stayed active, and the agent continued from a fresh snapshot without Resume. Explicit Take over/Resume/revoke, credential refusal and cross-origin confirmation remain separate hard boundaries.

The companion source version is now `0.2.1`. The previously signed `0.2.0` XPI is evidence only for the earlier source tuple and must not be used as signed/source-compatibility evidence for this implementation. No `0.2.1` XPI was signed or published in this slice; clean-machine and authenticated-user-profile acceptance for a new release candidate remain release-gate work.
