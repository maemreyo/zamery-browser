# @zamery/browser-mcp

A standalone [MCP](https://modelcontextprotocol.io) server that lets a local agent (for example Codex) use the Firefox you are already using — with your logins — on **only the tabs and tab groups you choose to share**.

```text
agent host (stdio) → @zamery/browser-mcp → BrowserProvider V2 + optional interfaces
  → @zamery/browser-firefox → Native Messaging host → Zamery Browser Companion → your Firefox
```

It does not depend on Pi or Zamery Workbench. It does not expose raw JavaScript/eval, and the agent cannot grant itself access.

> Status: technical preview in development. Do not rely on the install command below until a release candidate with a published, signed companion is announced.

## Install (prospective)

```bash
codex mcp add zamery-firefox -- npx -y @zamery/browser-mcp@<tested-version>
```

You also need the Firefox companion and the native host from `@zamery/browser-firefox` (see its README).

## Codex recipe (needed for screenshots)

In a tested Codex setup the model did not receive inline MCP images, so it guessed what a screenshot showed. `browser_screenshot` therefore also returns a local image file path, and the model must open it with its image viewer. Add [`codex/AGENTS.snippet.md`](codex/AGENTS.snippet.md) to your project's `AGENTS.md` (or install [`codex/skill/zamery-browser`](codex/skill/zamery-browser/SKILL.md) as a Codex skill). With it, a neutral visual question was answered correctly 3/3 against a real Firefox; without it, 0/2.

## How access works

1. The agent calls `browser_status`. It always works, even before Firefox is connected or anything is shared, and says what to ask you. If Firefox is connected but nothing is shared, the agent may call `browser_request_access` once to ask for your attention. The request contains no tab/group/action/duration choices and never grants anything.
2. Firefox shows a toolbar badge and, if you enabled optional notifications, a generic OS notification. You open the **Zamery Browser** panel and choose the local agent, the tab(s) or group, what the agent may do, and for how long (this session, or 1–30 days).
3. The agent calls `browser_contexts` / `browser_snapshot`. A snapshot with `claim=true` (default) takes the write claim; the returned short refs (`e1`, `e2`, …) can then be used with `browser_click`, `browser_fill`, `browser_type`, `browser_key`.
4. You can **take over** at any time from the panel (or by simply using the page). While you are in control the agent cannot act; it can only *ask* you to resume.

Sign-in, one-time-code and payment fields are never filled by the agent: they are flagged `CREDENTIAL` in snapshots and writes are refused; use `browser_handoff` (`request_user_takeover`).

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_status` | Connection, access, expiry, who is in control, and what to do next. |
| `browser_request_access` | Ask Firefox to draw the user's attention before a grant exists. It never grants, widens, resumes or confirms access. |
| `browser_contexts` | Tabs shared with the agent. |
| `browser_snapshot` | Controls of a shared tab (no form values, no hidden controls) and, by default, the write claim. |
| `browser_click` / `browser_fill` / `browser_type` / `browser_key` | Synthetic DOM actions (`isTrusted=false`). Need the claim and a fresh observation. |
| `browser_handoff` | `request_user_takeover`, `resume` (a request only), `claim`, `release`. |
| `browser_mutation_status` | Look up what happened to an action by its `request_id`. |
| `browser_tab` | Create/navigate/reload/activate/close-own tabs (only what you allowed). |
| `browser_groups`, `browser_group` | Read and change Firefox tab groups you shared. |

Every mutation carries a stable `request_id`. After a timeout or a lost response the outcome may be `outcome_unknown`: the agent must **not** retry with a new id; it checks `browser_mutation_status` and the page.

## Configuration (environment)

| Variable | Meaning |
| --- | --- |
| `ZAMERY_BROWSER_MCP_STATE_DIR` | Where the stable consumer id is stored (default `~/Library/Application Support/Zamery/browser-mcp`). |
| `ZAMERY_BROWSER_MCP_CONSUMER_ID` | Override the consumer id (`[A-Za-z0-9._:-]{8,128}`). |
| `ZAMERY_BROWSER_MCP_BROWSER_INSTANCE_ID` | Pin one Firefox profile when several are connected. |
| `ZAMERY_BROWSER_MCP_PROVIDER` | Provider allowlist selector; only `firefox` exists. Arbitrary module paths are rejected. |

The consumer id binds your grant to this installation, so restarting the MCP process or the agent keeps working under the same approval. It is a same-OS-user routing key, **not** an authenticated identity.

## Trust boundary

The local Firefox bridge trusts the logged-in OS user. Another process of the same user could talk to the bridge, but still needs the grant you created in Firefox for its own consumer id. Page content (titles, URLs, control names) is untrusted data and is labelled as such in tool output.

## License

Apache-2.0.
