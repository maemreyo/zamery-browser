import type { BrowserAuthorizationDetailV1 } from "@zamery/browser-provider";

/** Plain-language next steps. Never contains page-derived text. */
export function guidanceForAuthorization(detail: BrowserAuthorizationDetailV1): string[] {
  const out: string[] = [];
  switch (detail.state) {
    case "granted":
      break;
    case "revoked":
      out.push(
        detail.reason === "bound_to_other_consumer"
          ? "Access is shared with a different local agent. Ask the user to share with this agent from the Zamery Browser panel in Firefox."
          : "No tabs are shared with this agent. Ask the user to open the Zamery Browser panel in Firefox, choose this agent, select the tab(s) and press 'Share selected'. You cannot grant access yourself.",
      );
      break;
    case "rebind_required":
      out.push(
        `Firefox or the local bridge restarted. The user's approval is still valid${detail.expiresAt ? ` until ${new Date(detail.expiresAt).toISOString()}` : ""}, but they must choose the tabs again in the Zamery Browser panel ('Share again'). Old observations are gone.`,
      );
      break;
    case "expired":
      out.push("The user's access expired. Ask them to share again from the Zamery Browser panel in Firefox.");
      break;
    case "protocol_mismatch":
      out.push("The Firefox companion and the local bridge speak different protocol versions, so all access is blocked. Update both to a compatible pair (see the Zamery Browser setup documentation).");
      break;
    case "disconnected":
      out.push("No Firefox bridge is connected. Make sure Firefox is running with the Zamery Browser Companion enabled and the native host installed.");
      break;
  }
  if (detail.state === "granted") {
    if (detail.control.state === "user_control") {
      out.push(`The user is in control${detail.control.reason ? ` (${detail.control.reason})` : ""}. Do not try to act. Use browser_handoff with action "resume" to ask them to hand control back, then wait.`);
    } else if (detail.control.state === "shared_idle") {
      out.push("Nothing is claimed. browser_snapshot with claim=true takes the claim and returns refs you can act on.");
    }
  }
  return out;
}

const REASON_GUIDANCE: Readonly<Record<string, string>> = {
  user_control: "The user is in control. Do not act; ask them to resume (browser_handoff action=resume).",
  claim_required: "Take the claim first: browser_snapshot with claim=true, then use the new refs.",
  claim_changed: "The claim changed. Take a new browser_snapshot (claim=true) and use its refs.",
  claim_context_changed: "The claim moved to another tab. Take a new browser_snapshot (claim=true) of this tab.",
  user_interaction: "The user used the page, so they are in control now. Wait for them to resume, then take a new snapshot.",
  page_navigated: "The page navigated. Take a new browser_snapshot and use its refs.",
  document_changed: "The page was replaced. Take a new browser_snapshot and use its refs.",
  grant_changed: "The user's sharing changed. Check browser_status, then take a new snapshot.",
  audience_mismatch: "The user shared tabs with a different local agent.",
  bound_to_other_consumer: "The user shared tabs with a different local agent.",
  rebind_required: "The user must choose the shared tabs again in the Zamery Browser panel.",
  origin_changed_confirmation_required: "The shared tab navigated to another site. Ask the user to confirm it in the Zamery Browser panel.",
  private_window_denied: "Private windows can never be shared.",
  restricted_or_unsupported_page: "That page cannot be controlled (browser-internal or unsupported page).",
  claimed_tab_not_focused: "The claimed tab is not the active tab of the focused Firefox window. Use browser_tab action=activate (if allowed) or ask the user to bring it forward.",
  outside_scope: "That tab is not shared with you. Only tabs listed by browser_contexts are available.",
  left_authorized_group: "That tab left the shared group, so it is no longer shared with you.",
  partition_changed: "That tab's container changed, so it is no longer shared with you.",
  incomplete_membership_structural_change_refused: "That group has tabs that are not shared with you, so group-wide changes are refused.",
  pinned_tab_refused: "Pinned tabs cannot be grouped by the agent.",
  cross_origin_navigation_requires_user: "You can only navigate the user's tab within its current site. Open your own tab (browser_tab create) or ask the user.",
  credential_field: "This is a sign-in, code or payment field. The user must fill it themselves: use browser_handoff action=request_user_takeover.",
  credential_field_user_takeover_required: "This is a sign-in, code or payment field. The user must fill it themselves: use browser_handoff action=request_user_takeover.",
  action_outside_scope: "The user did not allow this kind of action. Ask them to widen it in the Zamery Browser panel if appropriate.",
};

export function guidanceForError(code: string, reason: string | undefined): string[] {
  const r = reason ?? "";
  if (REASON_GUIDANCE[r]) return [REASON_GUIDANCE[r]!];
  if (r.endsWith("_not_granted")) return ["The user did not allow this kind of action. Ask them to widen it in the Zamery Browser panel if appropriate."];
  return guidanceForCode(code, r);
}

function guidanceForCode(code: string, r: string): string[] {
  switch (code) {
    case "HOST_MISSING":
    case "COMPANION_NOT_READY":
    case "TRANSPORT_DISCONNECTED":
    case "BROWSER_INSTANCE_NOT_FOUND":
      return ["Firefox is not reachable. Check browser_status; ask the user to start Firefox with the Zamery Browser Companion."];
    case "PROTOCOL_MISMATCH":
    case "BROWSER_PROTOCOL_MISMATCH":
      return ["Companion and local bridge versions do not match; access is blocked until the user updates them."];
    case "REBIND_REQUIRED":
      return ["The user must choose the shared tabs again in the Zamery Browser panel."];
    case "AUTHORIZATION_EXPIRED":
      return ["Access expired. Ask the user to share again."];
    case "AUTHORIZATION_REVOKED":
    case "AUTHORIZATION_REQUIRED":
    case "BROWSER_AUTHORIZATION_REQUIRED":
      if (r === "user_control") return ["The user is in control. Do not act; ask them to resume (browser_handoff action=resume)."];
      if (r === "claim_required") return ["Take the claim first: browser_snapshot with claim=true, then use the new refs."];
      if (r === "claim_changed" || r === "claim_context_changed") return ["The claim changed. Take a new browser_snapshot (claim=true) and use its refs."];
      if (r === "audience_mismatch" || r === "bound_to_other_consumer") return ["The user shared tabs with a different local agent."];
      return ["Ask the user to share the tab(s) from the Zamery Browser panel; you cannot grant access yourself."];
    case "OUTSIDE_SCOPE":
      if (r === "origin_changed_confirmation_required") return ["The shared tab navigated to another site. Ask the user to confirm it in the Zamery Browser panel."];
      if (r === "action_outside_scope" || r.endsWith("_not_granted")) return ["The user did not allow this kind of action. Ask them to widen it in the Zamery Browser panel if appropriate."];
      return ["That tab is not shared with you. Only tabs listed by browser_contexts are available."];
    case "PRIVATE_WINDOW_DENIED":
      return ["Private windows can never be shared."];
    case "RESTRICTED_PAGE":
      return ["That page cannot be controlled (browser-internal or unsupported page)."];
    case "CLAIM_REQUIRED":
      return ["Take the claim first: browser_snapshot with claim=true."];
    case "CLAIM_CHANGED":
    case "STALE_OBSERVATION":
    case "STALE_ELEMENT_REF":
      return ["Your observation is stale (the page, claim or user activity changed). Take a new browser_snapshot and use its refs."];
    case "USER_CONTROL_ACTIVE":
      return ["The user is in control. Do not act; use browser_handoff action=resume to ask them to hand control back."];
    case "FOCUS_CHANGED":
    case "BROWSER_CONTEXT_UNAVAILABLE":
      return ["The claimed tab is not the active tab of the focused Firefox window. Use browser_tab action=activate (if allowed) or ask the user to bring it forward."];
    case "CONTEXT_GONE":
    case "BROWSER_CONTEXT_GONE":
      return ["That tab no longer exists. List contexts again."];
    case "UNSUPPORTED_INPUT_SEMANTICS":
      if (r.includes("credential")) return ["This is a sign-in, code or payment field. The user must fill it themselves: use browser_handoff action=request_user_takeover."];
      return ["The page does not support that input."];
    case "REQUEST_ID_CONFLICT":
      return ["That request_id was already used for a different action. Use a new request_id for a new action."];
    case "REPLAY_HORIZON_EXPIRED":
      return ["That request id is too old to reconcile. Inspect the page, then act with a new request_id if still needed."];
    case "OUTCOME_UNKNOWN":
    case "MUTATION_OUTCOME_UNKNOWN":
    case "BROWSER_ACTION_RESPONSE_LOST":
      return ["The action may or may not have happened. Do NOT retry with a new request_id. Call browser_mutation_status with the same request_id, then inspect the page."];
    case "PARTIALLY_APPLIED":
      return ["Some steps happened. The result lists them; do not assume a rollback. Inspect the current state."];
    case "ARTIFACT_EXPIRED":
      return ["That screenshot expired (time limit, or sharing ended/changed). Capture a new one with browser_screenshot."];
    case "ARTIFACT_NOT_FOUND":
      return ["Unknown screenshot artifact. Capture a new one with browser_screenshot."];
    case "ARTIFACT_SIZE_LIMIT":
      return ["The image is too large. Capture a smaller rect or use jpeg."];
    case "ARTIFACT_INTEGRITY_MISMATCH":
      return ["The screenshot could not be verified and was discarded. Capture it again."];
    case "RESOURCE_BUSY":
      return ["Another capture is running. Wait a moment and retry."];
    case "INVALID_ARGUMENT":
      return ["Check the arguments: rect sides are at most 4096 CSS px."];
    case "UNSUPPORTED_CAPABILITY":
      return ["This Firefox build or companion does not support that operation."];
    default:
      return [];
  }
}
