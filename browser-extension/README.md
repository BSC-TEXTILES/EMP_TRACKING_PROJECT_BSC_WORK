# Workforce Activity Bridge (browser extension)

Manifest V3 extension for Chrome, Brave, Edge and Firefox (Chromium build). It shares only the **active tab's domain, title and duration** with the Workforce monitoring API while an authorised session is active. It does not read page content, form fields, cookies, passwords, history or private-browsing data.

## Install (managed device)

1. Open the browser's extensions page and enable **Developer mode**.
2. Choose **Load unpacked** and select this folder.
3. Open the extension options.
4. Enter the Workforce server URL (for example `http://localhost:4000`) and a device token created on the Activity page or by the desktop agent (`wfm_dev_…`).
5. Start attendance and a monitored work session in the web app. The bridge begins sending approved domains only.

The server checks every domain against the monitoring policy and silently discards unapproved domains. Titles are stored only for approved domains. Reporting stops when the work session ends because the API rejects events without an active session.
