# Firefox setup

`@zamery/browser-firefox` talks to an already-running Firefox through two pieces:

1. the **Zamery Browser Companion** WebExtension (Mozilla-signed);
2. a local Native Messaging host installed by `@zamery/browser-firefox`.

> **Stable release.** Zamery Browser `v0.2.3` uses Mozilla-signed/public companion `0.2.5` (AMO version `6547131`, file `5091270`, SHA-256 `8e89599e36fcec8d13c6da9d31cccf871626ce8b80d83e4345cd110eb8f8f59c`) with `@zamery/browser-firefox@0.2.2`. The exact XPI/source tuple, signed real-profile behavior, clean published-artifact install and Official MCP Registry entry are accepted. Do not mix a protocol-1 companion (`0.1.x`) with a protocol-2 host: every operation fails closed and `doctor` tells you why.

## 1. Install the native host

```bash
npx @zamery/browser-firefox setup --dry-run   # what would be written
npx @zamery/browser-firefox setup
```

This writes the Native Messaging manifest, a launcher with an **absolute Node path** (Firefox started from the Dock has a minimal `PATH`) and the host script under `~/Library/Application Support/Zamery/browser-firefox`. It never launches, restarts or replaces Firefox, never installs the add-on for you, and never silently overwrites a different manifest (`--force` keeps a backup).

## 2. Install the signed companion

Install the public [Zamery Browser Companion on AMO](https://addons.mozilla.org/firefox/addon/f82d5bdb37964220aafe/) (Firefox asks you to confirm the add-on and its permissions: all-site access, tabs, tab groups). Stable `v0.2.3` uses Companion `0.2.5`. Production extension id: `zamery-browser-firefox@zamery.local`. Restart Firefox once so it starts the new host.

## 3. Check

```bash
npx @zamery/browser-firefox doctor
```

`doctor` is read-only. It reports Node/Firefox versions, manifest/launcher/host-copy drift, the add-on's state in your profile registry, a live handshake (Firefox version, companion version, protocol compatibility, whether anything is shared) and legacy-journal warnings, each with a concrete fix.

## 4. Share tabs with an agent

1. Connect an agent (for example the Codex MCP server, see [`@zamery/browser-mcp`](../packages/browser-mcp/README.md)). It appears as **Local agent** in the panel once it has called `browser_status`. Before any grant exists, the agent may call `browser_request_access` to light the toolbar badge and, if you enabled it, show a generic OS notification. That request is attention only: it cannot select tabs, actions, duration, grant access, resume control or confirm a new site.
2. Open the **Zamery Browser** toolbar panel, choose the agent, the tab(s) or tab group, what it may do, and for how long (this session, 1/3/7/14/30 days, or a custom 1–30 days). The panel shows the exact end time.
3. Use **Take over** whenever you want to drive; the agent can only ask to resume. **Manage access** can remove already-shared tabs/groups or disable capabilities in place. Adding access still requires a new explicit Share action. **Stop sharing** ends everything immediately.

After Firefox, the extension or the local bridge restarts, a fixed-duration approval remains valid but you must choose the tabs again ("Share again"); nothing is restored automatically.

Private windows can never be shared. Sign-in, MFA and payment fields are handed back to you.

The toolbar badge is always the fallback for pending attention. OS notifications are optional and are requested only when you explicitly enable **Notify me when an agent needs me** in the popup. Notification text is generic and contains no page title, URL, form value, OTP, hand-off note or other page content. Clicking a notification only focuses Firefox and tries to open the Zamery Browser panel; it never grants, resumes or confirms anything.

## Troubleshooting

- *No instances / not connected*: run `doctor`. Common causes: Firefox is closed, the companion is disabled, the manifest or launcher drifted (`setup --force`), or Node moved.
- *Protocol mismatch*: update the companion and the host to a compatible pair; `doctor` shows both versions.
- *Restricted context*: Firefox/internal pages refuse content-script injection and stay unavailable.
- *Stale ref / observation*: take a fresh snapshot instead of reusing an old ref.
- *Host log*: `~/Library/Application Support/Zamery/browser-firefox/native-host-stderr.log`.
