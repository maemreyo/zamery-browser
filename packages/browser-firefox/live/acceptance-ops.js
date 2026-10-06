// ACCEPTANCE-ONLY. Staged into an isolated, differently-named companion by stage-companion.mjs and never shipped.
// It lets a test controller perform the *user's* side of the product (grant, take over, rearrange tabs) through the
// same internal functions the popup uses, so the live run exercises real Firefox APIs, events and content scripts
// without needing UI automation of the toolbar popup.

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
    case "acceptance_reload_extension": setTimeout(() => browser.runtime.reload(), 200); return { reloading: true };
    case "acceptance_private_window": {
      const win = await browser.windows.create({ incognito: true, url: params.url });
      return { windowId: win.id, tabIds: (win.tabs || []).map((tab) => tab.id) };
    }
    case "acceptance_windows": return { windows: await browser.windows.getAll() };
    case "acceptance_pending_origin": return { pending: { ...pendingOriginChanges } };
    default: return undefined;
  }
}
