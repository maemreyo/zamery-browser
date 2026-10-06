# Privacy Policy

This policy applies to the Zamery Browser Companion for Firefox.

## What the companion can access

The companion requests broad page access because its purpose is to inspect and act on web pages selected by the user. Depending on the operation, it can process information such as page content, tab URLs and titles, page structure, and browser activity needed to perform the requested browser action.

The Firefox manifest declares the Mozilla data categories `browsingActivity`, `websiteContent`, and `websiteActivity` so these capabilities are explicit rather than hidden.

## Where data goes

The companion communicates with the locally installed Zamery Native Messaging host using Firefox Native Messaging. The companion source does not send page data to a Zamery-operated analytics, advertising, or telemetry service.

Data handed to the local Native Messaging host may subsequently be used by the software or AI system that the user has chosen to connect to Zamery Browser. The privacy terms of that connected software or service apply to any processing it performs after the local handoff.

## What is shared, and what is not

Only the tabs and tab groups the user selects in the companion panel are visible to the connected local agent. Unshared tabs are not probed, listed, snapshotted or captured. Private windows are never shared. Snapshots omit form-field values and hidden controls; sign-in, one-time-code and payment-like fields are flagged and the agent is not allowed to write to them. Screenshots show whatever is visible in the shared tab, including private content, and are handed to the connected agent.

## Storage

- **Firefox extension-local storage**: an installation/profile identifier, and, for fixed-duration approvals (1–30 days), a consent record: grant id, deadline, allowed actions, the connected agent's identifier and the *origins* (site names, not paths, titles or page content) that were shared. It never stores tab or group identities, URLs, titles, page text or form values, and a restart does not restore access: the user selects tabs again.
- **Local files written by the native host** under `~/Library/Application Support/Zamery/browser-firefox`: a per-profile mutation journal with a typed allowlist (operation, opaque ids, outcome) — never typed text, URLs, titles or page content — and a diagnostic log. Legacy plaintext journals from earlier versions are migrated to tombstones and deleted.
- **Screenshot artifacts**: stored for at most 30 minutes (and removed as soon as sharing ends or the consumer closes) in a per-consumer directory readable only by the user. They are never indexed or uploaded by the companion.

## User control

Browser control requires an explicit grant created in Firefox by the user: which agent, which tabs/groups, what it may do, and for how long (this session, or 1–30 days). The user can take over at any time, and *Stop sharing* ends access immediately and discards pending results and screenshots. Removing the add-on or stopping the local host also ends access; a restart never silently restores it.

## Remote services

The companion itself does not contain advertising, third-party analytics, or remote tracking code. Restricted Firefox/internal pages remain unavailable when Firefox blocks content-script injection.

## Changes

Material changes to this policy will be published in this repository together with the corresponding source changes.

## Contact

For privacy or security issues, use the repository's GitHub issue tracker for non-sensitive questions. For security-sensitive reports, follow [SECURITY.md](SECURITY.md) and use GitHub Private Vulnerability Reporting.
