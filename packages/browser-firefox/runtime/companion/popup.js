const stateEl = document.querySelector('#state');
const protocolEl = document.querySelector('#protocol');
const sessionEl = document.querySelector('#session');
const expiryEl = document.querySelector('#expiry');
const errorEl = document.querySelector('#error');
const grantButton = document.querySelector('#grant');
const revokeButton = document.querySelector('#revoke');

function formatExpiry(value) {
  if (!Number.isFinite(Number(value))) return '';
  return `Grant expires: ${new Date(Number(value)).toLocaleString()}`;
}

async function refresh() {
  errorEl.textContent = '';
  const status = await browser.runtime.sendMessage({ type: 'zamery_browser_firefox_auth_status' });
  stateEl.textContent = `Authorization: ${status?.state || 'unknown'}`;
  sessionEl.textContent = status?.current_host_session_id || 'no native-host session';
  const current = status?.current_host_protocol_version ?? '—';
  const expected = status?.expected_protocol_version ?? '—';
  protocolEl.textContent = `Protocol: host ${current} / companion ${expected}`;
  protocolEl.className = status?.protocol_compatible ? 'row muted' : 'row error';
  expiryEl.textContent = status?.state === 'granted' ? formatExpiry(status?.expires_at) : '';
  grantButton.disabled = !status?.current_host_session_id || !status?.protocol_compatible || status?.state === 'granted';
  revokeButton.disabled = status?.state !== 'granted';
  if (status?.current_host_session_id && status?.protocol_compatible === false) {
    errorEl.textContent = 'Native-host protocol mismatch. Grant is disabled.';
  }
}

grantButton.addEventListener('click', async () => {
  const result = await browser.runtime.sendMessage({ type: 'zamery_browser_firefox_grant' });
  if (result?.ok === false) errorEl.textContent = result?.error || 'Grant failed';
  await refresh();
});

revokeButton.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: 'zamery_browser_firefox_revoke' });
  await refresh();
});

void refresh();
