// BSC Activity Tracker – Browser Connector (Manifest V3).
//
// Reports ONLY the hostname of the active tab of the focused browser window to
// the BSC Activity Tracker agent running on this computer (127.0.0.1:47613).
// The agent combines it with its own foreground/idle/lock detection, so website
// time is counted only while this browser is the active application and the
// employee is active. Nothing is sent to any internet server by this extension.
//
// Never read or sent: page contents, full URLs (paths, queries), page titles,
// form data, cookies, passwords, history, downloads or incognito tabs.

const AGENT = 'http://127.0.0.1:47613';
let lastSent = { domain: undefined, at: 0 };

function browserKey() {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands || []).map((b) => b.brand);
  if (brands.some((b) => /Edge/i.test(b))) return 'edge';
  if (brands.some((b) => /Opera/i.test(b))) return 'opera';
  if (brands.some((b) => /Vivaldi/i.test(b))) return 'vivaldi';
  if (navigator.brave || brands.some((b) => /Brave/i.test(b))) return 'brave';
  if (/Firefox\//.test(navigator.userAgent)) return 'firefox';
  return 'chrome';
}

/** Hostname for normal web pages only; internal pages report no domain. */
function hostnameOf(tab) {
  if (!tab || tab.incognito || !tab.url) return null;
  try {
    const url = new URL(tab.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

async function activeDomain() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (!win || !win.focused) return null;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return hostnameOf(tab);
  } catch {
    return null;
  }
}

async function report(force = false) {
  const domain = await activeDomain();
  const now = Date.now();
  if (!force && domain === lastSent.domain && now - lastSent.at < 60_000) return;
  try {
    const response = await fetch(`${AGENT}/v1/tab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: browserKey(), domain }),
    });
    lastSent = { domain, at: now };
    const state = response.ok ? await response.json() : null;
    await chrome.action.setBadgeText({ text: response.ok ? '' : '!' });
    await chrome.action.setTitle({
      title: response.ok
        ? (state && state.websiteTracking ? 'BSC Activity Tracker: connected' : 'BSC Activity Tracker: connected (website tracking off)')
        : 'BSC Activity Tracker: agent not responding',
    });
  } catch {
    // Agent not running (e.g. personal computer or tracker stopped): nothing is recorded.
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
    await chrome.action.setTitle({ title: 'BSC Activity Tracker: agent not running on this computer' });
  }
}

chrome.tabs.onActivated.addListener(() => { void report(); });
chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (tab.active && (change.url || change.status === 'complete')) void report(); });
chrome.windows.onFocusChanged.addListener(() => { void report(true); });
chrome.runtime.onStartup.addListener(() => { void report(true); });
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('bsc-keepalive', { periodInMinutes: 1 });
  void report(true);
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'bsc-keepalive') void report(true); });
