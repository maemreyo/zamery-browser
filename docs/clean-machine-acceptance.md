# Clean-machine acceptance runbook (technical preview RC)

Purpose: prove that the **published, pinned** artifacts plus the **signed XPI** work on a macOS machine that has never seen this repository. Use only what a stranger could get: npm packages by exact version, the signed XPI, the recipe, and Codex. Do **not** clone the repo, use `pnpm`, or run anything from a checkout.

Machine: a clean macOS VM (or a different Mac) with a fresh user. A second user on the developer's Mac is only a "clean-user" run and does not satisfy the gate.

## 0. Candidate under test (fill in; must match the release tuple)

| Item | Value |
| --- | --- |
| `@zamery/browser-provider` | `0.2.2-rc.2` |
| `@zamery/browser-firefox` | `0.2.1-rc.2` |
| `@zamery/browser-mcp` | `0.1.0-rc.3` |
| Signed XPI | **pending** — must be a Mozilla-signed `0.2.1` artifact matching the release tuple |
| Companion | `0.2.1`, id `zamery-browser-firefox@zamery.local`, native wire 2 |
| Release git SHA | `70835abbd3f1dfc5722062813a3d003066f1658a` |
| macOS / arch | record: `sw_vers`, `uname -m` |
| Firefox | record the version (≥ 142) |
| Node | record `node -v` (≥ 22.19 < 25), and the **absolute path** that `which node` prints |
| Codex | record `codex --version` and the surface (CLI / desktop app) |

## 1. Prepare the machine

1. Fresh macOS user, no Zamery files: `ls ~/Library/Application\ Support/Zamery ~/Library/Application\ Support/Mozilla/NativeMessagingHosts` should not mention Zamery.
2. Install Firefox (release channel) and Node (22 or 24) and Codex. Launch Firefox once and **log in to one real site** (an account you can safely use, e.g. a throwaway account) so the profile has a real session. Open a second tab with another logged-in site and a third with an unrelated page.
3. Copy the signed XPI to the machine and verify it:
   ```bash
   shasum -a 256 <signed-0.2.1.xpi>    # must equal the SHA-256 recorded by release:tuple
   unzip -l <signed-0.2.1.xpi> | grep -E 'mozilla.rsa|manifest.json'
   ```

## 2. Install the pinned packages (no tags, no repo)

```bash
mkdir ~/zamery-rc && cd ~/zamery-rc && npm init -y
npm i --save-exact @zamery/browser-provider@0.2.2-rc.2 @zamery/browser-firefox@0.2.1-rc.2 @zamery/browser-mcp@0.1.0-rc.3
npm ls --all | grep zamery            # exact versions, no duplicates
npx zamery-browser-firefox setup --dry-run
npx zamery-browser-firefox setup
npx zamery-browser-firefox doctor     # expected: manifest/launcher/host copy OK; live session WARN (Firefox not yet running the companion)
```

Record the doctor output. Expected: no `fail` other than "no live session".

## 3. Install the companion

1. In Firefox open the XPI (File → Open File… or drag it into the window) and accept the permission prompt. Record the permissions shown (all-site access, tabs, tab groups).
2. Restart Firefox **once** (setup never does it for you).
3. `npx zamery-browser-firefox doctor` again. Expected: `Live handshake OK` with the Firefox version, companion `0.2.1`, protocol compatible, access `revoked`; the add-on appears as signed in the profile registry line.

## 4. Codex + recipe

1. Add the recipe to the project directory you will run Codex from:
   ```bash
   cp node_modules/@zamery/browser-mcp/codex/AGENTS.snippet.md ./AGENTS.md   # or append to an existing AGENTS.md
   ```
   (The tarball ships `codex/`; if it does not, record a packaging bug.)
2. Register the server with the **pinned** package:
   ```bash
   codex mcp add zamery-firefox -- npx -y @zamery/browser-mcp@0.1.0-rc.3
   ```
3. Start Codex. Ask: *"Call browser_status."* Expected: connected, access revoked, instructions to share from the panel. Record initialize time (Codex shows tool availability within its 10 s startup limit).

## 5. Scenarios (record result + one line of evidence for each)

| # | Do | Expected |
| --- | --- | --- |
| A | In Firefox: toolbar panel → agent appears as "Local agent (MCP: …)" → share **only the logged-in tab 1**, duration "This session", defaults | Codex `browser_contexts` lists exactly tab 1. Tabs 2 and 3 never appear. `browser_snapshot` on their ids is refused. |
| B | Ask Codex to read tab 1 and describe the page | Snapshot has no form values; page text is present; titles/URLs only for tab 1. Existing login is used (no relaunch, no cookie export). |
| C | Ask Codex to fill a harmless field and click a harmless button on tab 1 | Done with synthetic events; result verified by a fresh snapshot. |
| D | Ask Codex to fill the password/OTP field | Refused; panel shows "You are in control — sign-in or code field". Resume from the panel, then Codex can continue. |
| E | Click **Take over** in the panel; ask Codex to click | Refused (user control). Codex can only ask to resume; panel **Resume** hands back. Type in the page yourself while Codex holds the claim: control switches to you. |
| F | Navigate tab 1 to another site yourself | Access withdrawn until you confirm the new site in the panel; the new URL is not shown to Codex first. |
| G | Make a tab group of tabs 1+3, share the **group** (membership snapshot). Add tab 2 to the group | Codex sees tabs 1 and 3 only; tab 2 stays invisible; `incomplete_membership` true. Ask Codex to rename the group: refused. Remove tab 2 from the group and ask again: allowed, and Firefox shows the new name. |
| H | Share with "7 days". Quit Firefox, reopen, run `browser_status` | `rebind_required`, **same end time**; Codex cannot see tab 1 until you "Share again". |
| I | `browser_screenshot` of tab 1; ask Codex what it shows | Image opened via the recipe; answer matches what is visible. Also ask a pixel-level question about a colour block you know. |
| J | Stop sharing in the panel | Codex loses access immediately; the screenshot file path no longer opens (removed within ~15 s); `browser_artifact_read` says expired. |
| K | Kill the MCP process while a claim is held (`pkill -f browser-mcp`), then ask Codex again | New process keeps the grant; old observations are gone and Codex must re-snapshot. |
| L | Open a **private window** | Not visible, cannot be shared. |

Also record: whether any step required anything that is not in this runbook (that is a documentation bug).

## 6. Evidence to attach

- `sw_vers`, `uname -m`, Firefox/Node/Codex versions and Node absolute path.
- `npm ls --all | grep zamery` and the XPI SHA-256 check.
- `doctor` output before and after installing the companion (`--json` preferred).
- Pass/fail and a one-line observation per scenario A–L; screenshots of the panel for A, D, G, H.
- Codex session ids or transcripts for B–D and I (redact page content you do not want to share).
- Run `node scripts/release-tuple.mjs`-equivalent facts: they must show the same git SHA and XPI hash as section 0.

## 7. After the run

If A–L all pass with the signed XPI and pinned packages, mark acceptance rows 1, 2 and the real-profile part of 14 in `docs/technical-preview.md` and record the evidence. Any deviation means NO-GO: file it with the exact observation instead of editing the runbook to fit.
