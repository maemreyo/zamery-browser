# Zamery Browser community launch kit

Date: 2026-10-06.

This is the launch-ready messaging pack for accepted stable `v0.2.3`. Re-check community rules immediately before posting because subreddit/forum rules can change independently of this repository.

## Public state

- Stable release: `v0.2.3`.
- npm: `@zamery/browser-provider@0.2.3`, `@zamery/browser-firefox@0.2.2`, `@zamery/browser-mcp@0.1.2`, `@zamery/pi-browser@0.2.2`.
- Firefox Companion: public AMO `0.2.5`, AMO version `6547131`.
- Official MCP Registry: `io.github.maemreyo/zamery-browser@0.1.2`, active.
- Repository: https://github.com/maemreyo/zamery-browser
- AMO: https://addons.mozilla.org/firefox/addon/f82d5bdb37964220aafe/
- MCP Registry: https://registry.modelcontextprotocol.io/?q=io.github.maemreyo%2Fzamery-browser
- npm MCP package: https://www.npmjs.com/package/@zamery/browser-mcp
- Demo GIF: `docs/assets/brand/companion-flow.gif`.

Core positioning:

> Let an AI agent use the Firefox you already use, including logged-in tabs, while exposing only the tabs or tab groups you explicitly share. Local bridge, open source, MCP-compatible, with user takeover and revoke.

The public distinction is the existing user-owned Firefox session plus explicit sharing boundaries. Avoid reducing the description to “another browser automation MCP server”.

## Launch sequence

Use distinct posting windows. Do not cross-post the same promotional copy everywhere and do not request votes, stars, upvotes or coordinated comments.

1. Show HN.
2. Firefox/add-on developer discussion.
3. r/LocalLLaMA only if the posting account satisfies the community's current self-promotion expectations.
4. r/firefox only after a manual rule check immediately before posting.
5. r/ClaudeAI is currently **HOLD** unless the project can truthfully satisfy that community's Showcase requirement that it was built with Claude/Claude Code or specifically for Claude.

## Show HN

Current Show HN rules require something people can actually run/try, a title beginning with `Show HN`, personal involvement by the author, and no requests for friends to upvote/comment. Reference: https://news.ycombinator.com/showhn.html

Suggested title:

`Show HN: Zamery Browser – let AI agents use the Firefox you're already using`

Submit the GitHub repository URL. Suggested first comment:

> I built Zamery Browser because I wanted agents to work in the Firefox session I already use, including logged-in tabs, without exporting cookies or giving an agent my whole browser profile.
>
> The Firefox Companion uses Native Messaging to a local host. Nothing is shared until the user explicitly selects tabs or a tab group, capabilities and duration. The user can take over, reduce access or revoke it from Firefox. There is also a standalone stdio MCP server, so it is not tied to Pi or Workbench.
>
> The current release is public on AMO and in the Official MCP Registry. I would especially value feedback on the permission UX, takeover/rebind model and whether the install path is clear.

## r/ClaudeAI

**HOLD by default.** Recent moderation messages for the current Showcase rule require the project to say it was built with Claude/Claude Code or specifically for Claude and reject generic promotional framing/cross-posting. Zamery Browser's accepted positioning is model/host-neutral, so do not manufacture a Claude-specific claim.

Only revisit this channel if a future integration is genuinely Claude-specific and the current subreddit rules still allow the post.

## r/LocalLLaMA

**Conditional.** Recent Rule 4 moderation is strict about self-promotion and favors people who participate meaningfully in the community. Do not post from an account that would only appear to be promoting its own project.

If eligible under the current rules:

Title:

`Open-source MCP bridge for using an existing Firefox session with explicit tab sharing`

Body:

> I wanted local agent stacks to be able to use my already-running Firefox without copying a browser profile or exporting cookies.
>
> Zamery Browser uses a local Native Messaging bridge plus a Firefox Companion. The user explicitly shares tabs or tab groups and chooses capabilities/duration; revoke and takeover stay in Firefox. The MCP server is a standalone npm package and the registry entry is live.
>
> Repo: https://github.com/maemreyo/zamery-browser
> AMO: https://addons.mozilla.org/firefox/addon/f82d5bdb37964220aafe/
> MCP Registry: https://registry.modelcontextprotocol.io/?q=io.github.maemreyo%2Fzamery-browser
>
> The bridge can be used with local or cloud models, so I am not calling the whole stack “fully local AI”. Feedback on the local-browser permission boundary and MCP ergonomics is welcome.

## r/firefox

The automated Reddit rules endpoint returned HTTP 403 during this audit, so the current subreddit rules were not independently captured. Perform a manual rule check immediately before posting and skip the channel if project/self-promotion is disallowed.

If allowed:

Title:

`I built an open-source Firefox Companion that shares selected tabs with local AI agents`

Body:

> Zamery Browser Companion is a public Firefox add-on for connecting an existing Firefox profile to a local agent bridge. The user chooses the exact tabs/tab groups, capabilities and duration, and can take over or revoke access from the toolbar panel.
>
> The goal is to keep Firefox user-owned: no disposable automation profile, no cookie export, and no silent grant restoration after restart.
>
> AMO: https://addons.mozilla.org/firefox/addon/f82d5bdb37964220aafe/
> Source: https://github.com/maemreyo/zamery-browser
>
> I would value Firefox-specific feedback on permission UX, Native Messaging lifecycle and the takeover/rebind behavior.

## Mozilla add-on developer communities

Use this as an engineering discussion rather than a launch ad:

> We built an explicit-share Native Messaging bridge that lets local AI agents work with selected tabs in an existing Firefox profile. The Companion is public on AMO and the bridge is open source.
>
> The user selects tabs/tab groups, capabilities and duration in Firefox; attention never grants authority, restart requires explicit rebind, and takeover/revoke remain user-controlled.
>
> I am looking for feedback on permission UX, Native Messaging lifecycle and Firefox integration conventions.
>
> Source: https://github.com/maemreyo/zamery-browser
> AMO: https://addons.mozilla.org/firefox/addon/f82d5bdb37964220aafe/

Mozilla's current add-on community references point developers to add-ons community/Discourse spaces and Mozilla Community Participation Guidelines. Re-check the target forum/category rules before posting.

## Claims to avoid

- Do not say the whole AI stack is fully local; only the browser bridge is local.
- Do not claim a specific third-party host is fully accepted unless that host has its own recorded end-to-end acceptance.
- Do not describe Companion versions by source version alone; public claims should follow accepted signed XPI/release evidence.
- Do not reuse Companion version `0.2.5` for the separate agent-action-overlay lane. `0.2.5` is already the immutable public Companion for stable `v0.2.3`.
- Do not ask for votes, stars, upvotes or coordinated comments.
