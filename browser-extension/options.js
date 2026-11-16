const server = document.getElementById('server');
const token = document.getElementById('token');
const saved = document.getElementById('saved');

chrome.storage.local.get(['server', 'deviceToken']).then((stored) => {
  server.value = stored.server || 'http://localhost:4000';
  token.value = stored.deviceToken || '';
});

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    server: server.value.trim().replace(/\/$/, '') || 'http://localhost:4000',
    deviceToken: token.value.trim(),
  });
  saved.textContent = 'Saved';
  setTimeout(() => { saved.textContent = ''; }, 2000);
});
