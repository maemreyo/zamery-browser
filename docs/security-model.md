# Security model

Zamery Browser treats authorization, ownership, freshness, and mutation outcome as separate facts. This page describes what the Firefox path enforces **today**; items marked *not enforced* are deliberately out of scope for the technical preview.

## Trust boundary

The native host and the local socket are protected by the logged-in OS user (`0700` directories, `0600` socket/files). They do **not** isolate arbitrary software running as the same user. A same-user process can talk to the bridge, but it still needs a grant the user created in Firefox for *its* consumer id. A consumer id (audience) is a routing key, not an authenticated identity: the product never claims to know that the connected process is Codex, and the UI calls it "Local agent" with an informational label.

## Authorization is explicit, scoped and time-boxed

- **The user grants, in Firefox.** The agent cannot grant itself access, change its scope, or take over from the user. A grant names the agent, the tabs and/or tab groups, the allowed actions (read, click/type, screenshots, reorganize, open/close its own tabs) and a duration.
- **Consent is not a live binding.** *ConsentGrant* (duration: this session, or 1–30 days; exact deadline) is separate from *LiveBinding* (the concrete tabs/groups for the current native-host session). A fixed-duration consent survives restarts but never restores authority: after an extension reload, host restart or Firefox restart the user must pick the tabs again (keeping the original deadline). Tabs and groups are never re-matched by title, group name or numeric id. A wall-clock regression larger than five minutes requires re-confirmation.
- **Scope is enforced in the extension**, not only in the provider: every read, write, asset transfer, screenshot and artifact read re-checks the tab (shared? action allowed? same origin? same container? not private?). Unshared tabs are never probed or listed.
- **Origin is bound.** A shared tab that navigates to another origin is withdrawn until the user confirms the new site; the new URL/title is not exported before that.
- **Private windows are denied** (`incognito: not_allowed` in the manifest plus runtime checks).
- **Groups default to a membership snapshot.** Only the members shared at confirmation stay shared while they remain in the group; tabs that join later are not shared and re-entry does not restore access. `follow_group` is an explicit opt-in. The agent can only move tabs it already holds authority over into a group, and group-wide changes are refused when the group contains tabs not shared with it.

## Results are authorized too

Authorization is checked before execution **and** before a result leaves the companion. Caches, transfers, refs and artifacts are bound to the live binding and are dropped on revoke/expiry/rebind. A read that completes after a revoke is discarded; a mutation that was already dispatched reports only a safe status (it may have happened; revoking cannot undo it).

## Human ↔ agent control

A write needs a *claim* (taken with a snapshot) and an observation taken at the current claim generation, in the active tab of Firefox's last-focused window. The claim ends and the agent is blocked when the user takes over (panel button), uses the page (trusted pointer/key/input events on the claimed tab), switches tabs/windows, navigates manually, when the agent reaches a sign-in/code field, or when an action's outcome is unknown. The agent can only *ask* to resume; only the user resumes. Detection of human activity is best-effort (OS-level dialogs and some gestures are invisible to extensions); the panel's Take over button is authoritative.

## Privacy of what the agent sees

- Snapshots export **no form values**, exclude hidden/non-rendered controls and report truncation and top-frame-only coverage. Password, one-time-code and payment-like fields are flagged and writes to them are refused (the agent hands over to the user).
- Visible reading text is bounded and never taken from form controls, editable regions, scripts or hidden content. All page-derived text is untrusted data and is labelled so in tool output.
- Screenshots contain whatever is visible. They are bounded, stored as short-lived (30 min) artifacts in a `0700` per-consumer directory with `0600` files and opaque ids, verified by SHA-256, removed when sharing ends or the provider closes, and never addressable by a caller-supplied path. No generic redaction is attempted: do not share a tab whose visible content you would not show the agent.

## Durable journal

The native host keeps a per-profile, per-consumer mutation journal for recovery. It never stores `fill`/`type`/`key` payloads, URLs, titles or page-bearing results — only a typed allowlist (operation, opaque context/ref ids, outcome). After a restart a sensitive mutation that cannot be reconciled is reported as `outcome_unknown`; the system does not pretend to be exactly-once. Legacy plaintext journals are migrated to tombstones and deleted on first start. Old backups or logs outside the managed directory are not erased.

## Action outcomes are not collapsed

A mutation reports exactly `completed`, `not_started`, `partially_applied` or `outcome_unknown`. A lost response after dispatch is `outcome_unknown` and must be reconciled with `mutation_status` using the same request id; it is never retried with a new id.

## Firefox actions are synthetic

The extension dispatches DOM events (`isTrusted=false`). It does not claim trusted OS/browser input, cannot automate native file choosers, passkeys or OS dialogs, and cannot bypass user-activation requirements. Raw JavaScript/eval is not exposed.

## Extension permissions

`<all_urls>` (exact-tab screenshots and content injection into shared tabs), `tabs`, `tabGroups`, `storage`, `nativeMessaging`. No `downloads`, `cookies`, `webRequest`, clipboard or `incognito` access. Restricted Firefox/internal pages remain unavailable.

## Credentials

No npm, GitHub, Mozilla AMO, browser-session, or local authorization credentials belong in this repository or published npm tarballs.

## Not enforced / out of scope for the preview

Trusted native input, OS-level dialogs, uploads/downloads, iframe traversal, closed shadow roots, console/network capture, authentication of the consuming process, protection from a compromised OS account.
