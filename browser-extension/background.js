// Records only the active tab's domain, title and duration during an authorised
// monitoring session. Page contents, form inputs, cookies and passwords are
// never read. The server rejects domains outside the approved policy.
let current = null;
let server = 'http://localhost:4000';
let token = '';

async function settings() {
  const stored = await chrome.storage.local.get(['server', 'deviceToken']);
  server = (stored.server || server).replace(/\/$/, '');
  token = stored.deviceToken || '';
}

function domainOf(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

async function flush(next) {
  await settings();
  const now = Date.now();
  const finished = current;
  current = next;
  if (!finished || !token) return;
  const seconds = Math.round((now - finished.startedAt) / 1000);
  if (seconds < 5) return;
  try {
    await fetch(`${server}/api/activity/agent/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': token },
      body: JSON.stringify({
        events: [{
          type: 'browser',
          clientEventId: crypto.randomUUID(),
          browser: navigator.userAgent.includes('Edg/') ? 'Microsoft Edge'
            : navigator.userAgent.includes('Firefox') ? 'Firefox'
            : navigator.userAgent.includes('Brave') ? 'Brave Browser' : 'Google Chrome',
          domain: finished.domain,
          tabTitle: finished.title,
          category: 'Business Operations',
          startedAt: new Date(finished.startedAt).toISOString(),
          endedAt: new Date(now).toISOString(),
          activeSeconds: seconds,
        }],
      }),
    });
  } catch {
    // Offline: the next activation/interval retries with fresh metadata only.
  }
}

async function captureActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.url) return;
  const domain = domainOf(tab.url);
  if (!domain) return;
  if (current && current.domain === domain) {
    current.title = tab.title || current.title;
    return;
  }
  await flush({ domain, title: (tab.title || '').slice(0, 240), startedAt: Date.now() });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('workforce-flush', { periodInMinutes: 1 });
  void captureActiveTab();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('workforce-flush', { periodInMinutes: 1 });
  void captureActiveTab();
});

chrome.tabs.onActivated.addListener(() => { void captureActiveTab(); });
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.status === 'complete' && tab.active) void captureActiveTab();
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) void flush(null);
  else void captureActiveTab();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'workforce-flush') void captureActiveTab();
});
