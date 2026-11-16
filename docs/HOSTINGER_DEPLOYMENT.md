# Hostinger Deployment Guide for emptrack.bsctextiles.in

## If `/api/*` returns 404 while the page loads

A page that renders but whose `/api/auth/me`, `/api/health` (and every other `/api/*` path) return Hostinger HTML `404` means the domain is pointed at **static web hosting**, not at the Node application. Uploading `frontend/dist` alone can never serve the API: LiteSpeed/Apache has no Node process and no proxy for `/api`.

Check with:

```bash
curl -i https://emptrack.bsctextiles.in/api/health
```

- `200` + JSON → Node is serving.
- `404` + `Content-Type: text/html` + `Server: hcdn` → static hosting only (this is the current live state).

### Fix: deploy the whole repository as one Node.js Web App

Hostinger supports this on Business Web Hosting and Cloud plans (VPS requires manual Nginx/PM2 setup). Do **not** keep a separate static site for the same domain.

1. hPanel → **Websites → Create site → Web App** and choose `emptrack.bsctextiles.in` (or create `app.emptrack.bsctextiles.in` if the existing static site must stay). If the domain is already used by a static site, remove/reassign that site first; a domain can only route to one application.
2. Connect the Git repository (or upload a ZIP of the repository **including `frontend/dist` and `backend/dist`**, excluding `node_modules`).
3. Settings:
   - Node.js: 22
   - Root directory: repository root (the folder containing `package.json`, `server.js`, `backend/`, `frontend/`)
   - Build command: `npm ci && npm run build`
   - Start command / startup file: `npm start` or `server.js`
4. Environment variables (hPanel → Web App → Environment):
   ```
   NODE_ENV=production
   APP_URL=https://emptrack.bsctextiles.in
   FRONTEND_URL=https://emptrack.bsctextiles.in
   BACKEND_URL=https://emptrack.bsctextiles.in
   APP_ORIGIN=https://emptrack.bsctextiles.in
   APP_TIMEZONE=Asia/Kolkata
   WEB_SETUP_ENABLED=true
   WORKFORCE_CONFIG_DIR=./backend/storage/config
   UPLOAD_DIR=./storage/uploads
   ```
   Do not set `PORT`; Hostinger injects it. Do not copy `/srv/workforce/...` paths from the VPS template. Database/SMTP/administrator credentials are entered at `/setup`.
5. Ensure `backend/storage/config` and `storage/uploads` are writable by the app; back them up. Hostinger-managed apps can stop when idle, so in-process cron jobs (attendance auto-close, retention) may not run on schedule — use a VPS if reliable scheduling, long-lived WebSockets or ClamAV are required.
6. Open `https://emptrack.bsctextiles.in/setup`, complete installation, then verify:
   ```bash
   curl -i https://emptrack.bsctextiles.in/api/health   # 200 JSON
   curl -i https://emptrack.bsctextiles.in/api/auth/me  # 401 JSON when signed out
   ```
   Only then will sign-in work. `/api/auth/test-accounts` is expected to be `404` in production; the production frontend no longer requests it.

### Alternative: VPS

Use `deploy/nginx.conf`, run `node server.js` under systemd/PM2 on `127.0.0.1:4000`, and point the domain's `A` record at the VPS. The domain currently resolves to Hostinger shared-hosting CDN addresses, so Nginx on a VPS will not receive traffic until DNS changes.

## Why 403 Forbidden Occurred

When visiting `https://emptrack.bsctextiles.in/`, Hostinger's LiteSpeed/Apache edge server responded with:
```
HTTP/1.1 403 Forbidden
platform: hostinger
panel: hpanel
Server: hcdn
<p>Access to this resource on the server is denied!</p>
```

This error happens for one of two setup reasons:

---

### Situation A: You are using Hostinger Shared / Cloud Web Hosting

In Hostinger Web Hosting, LiteSpeed/Apache looks inside the document root folder (`public_html` or `domains/emptrack.bsctextiles.in/public_html`) for an index file (`index.html` or `index.php`).

If:
1. The folder is empty, OR
2. You cloned/uploaded the entire repository root into `public_html` (which only contained `backend`, `frontend`, `package.json`, but no root `index.html`), OR
3. An `.htaccess` file was missing to rewrite Single Page Application routes to `index.html`.

Hostinger blocks directory browsing by default (`Options -Indexes`), which triggers the **403 Forbidden** page.

#### Why uploading `dist` alone is not enough

The hosted page can load while every API call fails, because static hosting does not run `server.js`. Use the Node.js Web App deployment above; the steps below only describe the static assets and are not a complete deployment.

#### Static asset upload (only as part of a Node app):
1. **Build the project locally:**
   ```bash
   npm run build
   ```
2. **Deploy the built frontend:**
   - In Hostinger hPanel File Manager, open the document root for `emptrack.bsctextiles.in` (typically `public_html` or `domains/emptrack.bsctextiles.in/public_html`).
   - Upload the files from `frontend/dist/` directly into this folder:
     - `index.html`
     - `.htaccess` (automatically included in `frontend/dist` from `frontend/public/.htaccess`)
     - `assets/` folder
     - `manifest.webmanifest`, `icon.svg`, `sw.js`
3. **Run the backend using Hostinger Node.js:**
   - In hPanel, go to **Websites** -> **Manage** -> **Node.js**.
   - Set **Node.js version**: 20.x or 22.x.
   - Set **Application root**: the project root directory.
   - Set **Application startup file**: `server.js` (now provided at root).
   - Enter your environment variables or upload `.env.production`.

---

### Situation B: You are using a VPS (Virtual Private Server)

If you configured a VPS with Nginx and Node.js:
1. Check the DNS for `emptrack.bsctextiles.in`. Currently, it resolves to:
   - `147.79.69.208`
   - `93.127.173.178`
   These are **Hostinger Shared Hosting CDN** IPs, NOT your VPS IP!
2. Go to **hPanel -> DNS Zone Editor** for `bsctextiles.in`.
3. Find the `A` record for `emptrack` and change its IP to your **VPS IP address**.
4. Once DNS propagates, traffic will route directly to your VPS Nginx server.
5. On the VPS:
   - Copy `deploy/nginx.conf` into `/etc/nginx/sites-available/emptrack.conf`.
   - Symlink to `/etc/nginx/sites-enabled/`.
   - Run `nginx -t` and `systemctl reload nginx`.
   - Run the backend service: `node server.js` (or via PM2: `pm2 start server.js --name workforce`).

---

## Codebase Fixes Applied

1. **Root Entrypoint (`server.js` & `index.js`)**:
   Added `server.js` and `index.js` at the workspace root so Hostinger Node.js can start the backend directly.
2. **Apache / LiteSpeed `.htaccess`**:
   Added `.htaccess` to `frontend/public/` (copied into `frontend/dist/` on build) and the workspace root. Enables SPA routing and prevents 403 Forbidden on page refreshes.
3. **Nginx Header Inheritance (`deploy/nginx.conf`)**:
   Fixed `proxy_set_header` in `/` and `/api/` blocks so `Host $host`, `X-Forwarded-Proto $scheme`, and `X-Forwarded-For $remote_addr` are correctly passed to Express, preventing `originGuard` 403 cross-origin errors.
4. **Resilient Static File Serving (`backend/src/index.ts`)**:
   Enhanced client directory discovery to inspect multiple potential paths (`process.env.CLIENT_DIR`, `frontend/dist`, `dist`, `public_html`). Added fallback response if the frontend has not yet been built.
5. **Config & Environment Fallbacks (`backend/src/config.ts`)**:
   Enabled fallback loading from `.env` and `backend/.env` even when `NODE_ENV=production`, preventing startup crashes when production variables are stored in `.env`.
6. **Port-Agnostic Origin Validation (`backend/src/middleware/security.ts`)**:
   Normalized host header and origin URLs to prevent false 403 cross-origin blocks when ports (80/443) or protocols differ slightly.
7. **Production Environment File (`.env.production`)**:
   Provided a pre-configured `.env.production` pointing to `https://emptrack.bsctextiles.in`.
