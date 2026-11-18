# MOBILE_APP.md — mobile experience (PWA)

> The native Android / iOS app (Capacitor) is described in [MOBILE_NATIVE_APP.md](MOBILE_NATIVE_APP.md); its API (token sign-in, push, media links) in [MOBILE_BACKEND.md](MOBILE_BACKEND.md). Section 6 below predates it: bearer-token login now exists (`/api/auth/mobile/*`).

## 1. Approach

The platform ships as a **responsive web application + installable Progressive Web App**. It uses the same REST API and Socket.IO server as the desktop app, so data is identical and synchronised in real time; there is no second backend or divergent logic.

A native React Native shell could reuse the documented API contracts (section 6) without server changes.

## 2. What makes it app-like

- `frontend/public/manifest.webmanifest`: name, short name, theme colour (`#1d4ed8`), background, standalone display, icons (192/512, maskable).
- `frontend/public/sw.js`: caches the app shell and static assets; navigation requests fall back to the cached shell; API and socket traffic is never cached.
- Registered from `frontend/src/main.tsx` in production builds.
- Viewport meta with `viewport-fit=cover`, safe-area padding, 44px minimum touch targets, bottom-friendly layouts.
- Collapsible sidebar becomes a drawer under 1024px; tables become cards; forms stack; charts resize.

## 3. Install

**Android/Chrome:** open the site → menu → *Install app* (or the in-app prompt).
**iOS/Safari:** Share → *Add to Home Screen*.
**Desktop Chrome/Edge:** install icon in the address bar.

Requirements: HTTPS (or localhost) and a successful first load.

## 4. Mobile feature coverage

| Feature | Behaviour on mobile |
|---|---|
| Login / OTP | Full-screen forms, numeric keypad for OTP, remember device |
| Attendance | Large check-in/out buttons; timer ticks from server state; survives app backgrounding and reload |
| Tasks | Card list, swipe-free explicit buttons; accept/start/submit from the detail sheet |
| Daily report | Native date picker, camera/gallery attachments |
| Chat | WhatsApp-style bubbles, attachment sheet, typing and read receipts over the socket |
| Tickets | Create with photo evidence, track status |
| Notifications | Real-time in-app popups + badge; notification centre with bulk read |
| Calendar | Day/agenda-first layout |
| Meetings | Join from the meetings list; WebRTC camera/mic on mobile browsers (HTTPS required) |
| KPI | Own score, parameter breakdown and trend |
| Profile | View details, change password, manage sessions |

## 5. Offline and poor networks

- The service worker serves the shell offline; API calls then fail with a clear offline message instead of a blank screen.
- Chat and list screens retry on reconnect; Socket.IO reconnects with backoff and the client refetches missed state (`resync`).
- Attendance is intentionally **not** queued offline: check-in/out requires a server timestamp to remain trustworthy.
- Attachments upload with progress and a retry action.

## 6. API contract for a native client

| Concern | Contract |
|---|---|
| Base URL | `https://<host>/api` |
| Auth | `POST /auth/login` → httpOnly cookie (web). A native app should add a bearer-token flow or use a cookie-capable client; the API currently issues cookie sessions only |
| Realtime | Socket.IO at the same origin with `withCredentials: true`; events listed in `API_DOCUMENTATION.md` §16 |
| Timestamps | ISO-8601 UTC; render in device timezone |
| Pagination | `page`/`pageSize`, response `{items,total,page,pageSize}` |
| Errors | `{error, code}` with HTTP status |

Implementing a native app requires either (a) a cookie-capable HTTP client plus WebSocket upgrade headers, or (b) adding a bearer-token login endpoint that returns the same JWT the cookie carries. Option (b) is a small, isolated change.

## 7. Release checklist

- [ ] Manifest icons and theme colour match branding
- [ ] Service worker version bumped on each release (cache invalidation)
- [ ] Tested on a real Android device and an iPhone (Safari)
- [ ] Camera/microphone permissions tested over HTTPS
- [ ] Deep links (if added) verified on cold start
- [ ] Push notifications configured if required (needs VAPID keys — not included)
- [ ] Store listing (if wrapping with Capacitor/Bubblewrap) points at the production URL
