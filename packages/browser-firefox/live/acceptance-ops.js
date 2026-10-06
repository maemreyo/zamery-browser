// ACCEPTANCE-ONLY. Staged into an isolated, differently-named companion by stage-companion.mjs and never shipped.
// It lets a test controller perform the *user's* side of the product (grant, take over, rearrange tabs) through the
// same internal functions the popup uses, so the live run exercises real Firefox APIs, events and content scripts
// without needing UI automation of the toolbar popup.

let acceptanceCaptureGate = null;
globalThis.ZameryAcceptanceCaptureGate = Object.freeze({
  async waitBeforeCapture() {
    const gate = acceptanceCaptureGate;
    if (!gate) return;
    gate.entered = true;
    await gate.release;
  },
});

async function executeAcceptanceOp(op, params) {
  const slim = (tab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active, pinned: tab.pinned, groupId: tab.groupId, windowId: tab.windowId, index: tab.index, incognito: tab.incognito });
  switch (op) {
    case "acceptance_grant": return grantFromPopup(params);
    case "acceptance_add_tabs": return addTabsFromPopup(params);
    case "acceptance_revoke": endAuthority("user_revoked"); return authorizationStatus({ detail: "popup" });
    case "acceptance_takeover": userTakeover("user_takeover"); return authorizationStatus({ detail: "popup" });
    case "acceptance_resume": applyControl({ type: "resume" }); return authorizationStatus({ detail: "popup" });
    case "acceptance_confirm_origin": return confirmOrigin(Number(params.tab_id));
    case "acceptance_status": return authorizationStatus({ detail: "popup" });
    case "acceptance_tabs": return { tabs: (await browser.tabs.query({})).map(slim) };
    case "acceptance_groups": return { groups: await browser.tabGroups.query({}) };
    case "acceptance_open_tab": return slim(await browser.tabs.create({ url: params.url, active: params.active !== false, ...(params.window_id ? { windowId: params.window_id } : {}) }));
    case "acceptance_close_tab": await browser.tabs.remove(params.tab_id); return { closed: true };
    case "acceptance_activate_tab": {
      const tab = await browser.tabs.update(params.tab_id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
      return slim(tab);
    }
    case "acceptance_navigate_tab": return slim(await browser.tabs.update(params.tab_id, { url: params.url }));
    case "acceptance_group": {
      const groupId = await browser.tabs.group({ tabIds: params.tab_ids });
      if (params.title || params.color) await browser.tabGroups.update(groupId, { ...(params.title ? { title: params.title } : {}), ...(params.color ? { color: params.color } : {}) });
      return { groupId };
    }
    case "acceptance_move_into_group": await browser.tabs.group({ groupId: params.group_id, tabIds: params.tab_ids }); return { moved: true };
    case "acceptance_ungroup": await browser.tabs.ungroup(params.tab_ids); return { ungrouped: true };
    case "acceptance_page_script": {
      // Page-origin script executed in the tab's page (untrusted events, like any page script).
      const [result] = await browser.tabs.executeScript(params.tab_id, { code: String(params.code), runAt: "document_idle" });
      return { result: result ?? null };
    }
    case "acceptance_capture_raw": {
      // Acceptance-only pixel probe. This deliberately bypasses the product screenshot coordinator so the
      // live suite can prove the presentation is visible before separately proving product capture suppresses it.
      const rect = params.rect && typeof params.rect === "object" ? {
        x: Number(params.rect.x), y: Number(params.rect.y), width: Number(params.rect.width), height: Number(params.rect.height),
      } : undefined;
      const dataUrl = await browser.tabs.captureTab(Number(params.tab_id), { format: "png", scale: 1, ...(rect ? { rect } : {}) });
      return { data_url: dataUrl };
    }
    case "acceptance_capture_gate_arm": {
      if (acceptanceCaptureGate) throw new Error("acceptance capture gate already armed");
      let release;
      acceptanceCaptureGate = { entered: false, release: new Promise((resolve) => { release = resolve; }), resolve: release };
      return { armed: true };
    }
    case "acceptance_capture_gate_status": return { armed: Boolean(acceptanceCaptureGate), entered: acceptanceCaptureGate?.entered === true };
    case "acceptance_capture_gate_release": {
      const gate = acceptanceCaptureGate;
      acceptanceCaptureGate = null;
      gate?.resolve?.();
      return { released: Boolean(gate), entered: gate?.entered === true };
    }
    case "acceptance_reload_extension": setTimeout(() => browser.runtime.reload(), 200); return { reloading: true };
    case "acceptance_private_window": {
      const win = await browser.windows.create({ incognito: true, url: params.url });
      return { windowId: win.id, tabIds: (win.tabs || []).map((tab) => tab.id) };
    }
    case "acceptance_windows": return { windows: await browser.windows.getAll() };
    case "acceptance_pending_origin": return { pending: { ...pendingOriginChanges } };
    case "acceptance_set_agent_presence": {
      agentPresenceEnabled = params.enabled !== false;
      await persistAgentPresencePreference();
      if (!agentPresenceEnabled) clearAgentPresenceForTabs(authorizedTabIds(), "preference_disabled");
      await syncAgentPresenceForAuthorizedTabs();
      return { enabled: agentPresenceEnabled };
    }
    case "acceptance_presence_debug": {
      const [result] = await browser.tabs.executeScript(Number(params.tab_id), {
        code: "globalThis.ZameryAcceptancePresenceDebug?.snapshot?.() || null",
        runAt: "document_idle",
      });
      return { presence: result ?? null };
    }
    case "acceptance_presence_control": {
      const forceReducedMotion = params.force_reduced_motion === true;
      const throwAnimation = params.throw_animation === true;
      const code = `globalThis.ZameryAcceptancePresenceControl = ${JSON.stringify({ forceReducedMotion, throwAnimation })}; globalThis.ZameryAcceptancePresenceControl`;
      const [result] = await browser.tabs.executeScript(Number(params.tab_id), { code, runAt: "document_idle" });
      return { control: result ?? null };
    }
    case "acceptance_set_zoom": {
      const factor = Number(params.factor);
      await browser.tabs.setZoom(Number(params.tab_id), factor);
      return { zoom: await browser.tabs.getZoom(Number(params.tab_id)) };
    }
    default: return undefined;
  }
}
