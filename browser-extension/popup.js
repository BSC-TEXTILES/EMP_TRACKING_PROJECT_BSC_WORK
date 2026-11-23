(async () => {
  const status = document.getElementById('status');
  const label = document.getElementById('label');
  const detail = document.getElementById('detail');
  try {
    const response = await fetch('http://127.0.0.1:47613/v1/status');
    const body = await response.json();
    status.className = `status ${body.websiteTracking ? 'ok' : 'warn'}`;
    label.textContent = body.websiteTracking ? 'Connected to the tracker' : 'Connected — website tracking is off';
    detail.textContent = `Agent version ${body.agent}.`;
  } catch {
    status.className = 'status warn';
    label.textContent = 'Tracker not running';
    detail.textContent = 'The BSC Activity Tracker is not running on this computer, so no website activity is recorded.';
  }
})();
