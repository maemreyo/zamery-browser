# Privacy Policy

This policy applies to the Zamery Browser Companion for Firefox.

## What the companion can access

The companion requests broad page access because its purpose is to inspect and act on web pages selected by the user. Depending on the operation, it can process information such as page content, tab URLs and titles, page structure, and browser activity needed to perform the requested browser action.

The Firefox manifest declares the Mozilla data categories `browsingActivity`, `websiteContent`, and `websiteActivity` so these capabilities are explicit rather than hidden.

## Where data goes

The companion communicates with the locally installed Zamery Native Messaging host using Firefox Native Messaging. The companion source does not send page data to a Zamery-operated analytics, advertising, or telemetry service.

Data handed to the local Native Messaging host may subsequently be used by the software or AI system that the user has chosen to connect to Zamery Browser. The privacy terms of that connected software or service apply to any processing it performs after the local handoff.

## Storage

The companion may use Firefox extension-local storage for operational state such as authorization and browser/session identifiers. It is not intended as a general archive of browsing history or page content.

## User control

Browser control requires an explicit authorization grant to the current local native-host session. Removing the add-on, revoking the local authorization, or stopping the local host prevents further use through that connection.

## Remote services

The companion itself does not contain advertising, third-party analytics, or remote tracking code. Restricted Firefox/internal pages remain unavailable when Firefox blocks content-script injection.

## Changes

Material changes to this policy will be published in this repository together with the corresponding source changes.

## Contact

For privacy or security issues, use the repository's GitHub issue tracker for non-sensitive questions. For security-sensitive reports, follow [SECURITY.md](SECURITY.md) and use GitHub Private Vulnerability Reporting.
