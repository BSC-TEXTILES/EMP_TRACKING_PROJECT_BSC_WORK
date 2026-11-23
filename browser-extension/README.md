# BSC Activity Tracker – Browser Connector (Chrome / Edge, Manifest V3)

This connector tells the **BSC Activity Tracker** agent on the same computer which
website is open in the active tab. It sends the hostname only, for example
`mail.google.com`, to `http://127.0.0.1:47613`. The agent counts that website's time
only while the browser is the foreground application and the employee is active. The
extension itself never contacts any internet server.

**Never read or sent:** page contents, full URLs (paths and queries), page titles,
forms, cookies, passwords and history. Incognito windows are ignored, and
`chrome://`, `edge://` and `file://` pages report no domain.

**Permissions:**
* `tabs`, to read the active tab's address and reduce it to a hostname.
* `alarms`, for a one-minute keep-alive.
* Host access to `127.0.0.1:47613` only.

## Deploy

* **Managed (recommended):** package the folder as a CRX and host it internally, or
  publish it privately in the Chrome Web Store or Edge Add-ons. Then force-install it
  with the `ExtensionInstallForcelist` group policy for Chrome and Edge.
* **Manual / testing:** open `chrome://extensions` or `edge://extensions`, turn on
  *Developer mode*, choose *Load unpacked*, and select this folder.

The toolbar popup shows whether the local tracker is reachable. When the agent is not
running, nothing is recorded.

The previous "Workforce Activity Bridge" (which needed a pasted device token and sent
tab titles) has been retired.
