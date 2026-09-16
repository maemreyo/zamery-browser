# Security model

Zamery Browser treats authorization, ownership, freshness, and mutation outcome as separate facts.

## Authorization is explicit

A live provider session does not become authorized merely because a process started successfully. The Firefox companion/native-host path exposes authorization state separately and can fail closed on protocol mismatch or missing authorization.

## The browser remains user-owned

The Firefox provider targets an already-running browser. Provider lifecycle cleanup must not be interpreted as permission to close the user's browser, profile, or tabs.

## Snapshot refs are not durable selectors

Semantic snapshots return opaque refs tied to provider-observed browser state. Consumers should not treat those refs as permanent DOM selectors or reuse them after freshness becomes unknown/stale.

## Action outcomes are not collapsed

A mutation can report outcomes such as completed, not started, partial, or unknown. In particular, a timeout after mutation may have begun is not safe to retry blindly.

## Firefox actions are synthetic

The current Firefox action path uses DOM-synthetic events. It does not claim trusted OS/browser input (`isTrusted=true`) and should not be used to bypass user-activation or trusted-input requirements.

## Extension permissions

The signed Firefox companion requests broad page access because it must inspect and act across user-selected web pages. Restricted Firefox/internal surfaces remain unavailable when content-script injection is blocked. The companion is currently Mozilla-signed but unlisted/self-distributed rather than a public AMO listing.

## Credentials

No npm, GitHub, Mozilla AMO, browser-session, or local authorization credentials belong in this repository or published npm tarballs. Release credentials are kept outside package source/artifacts.
