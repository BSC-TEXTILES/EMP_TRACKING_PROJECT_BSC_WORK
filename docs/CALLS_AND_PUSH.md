# Calls, chat alerts and push notifications

How incoming calls ring, how chat messages alert, and how both keep working when the
app is closed, in the background, the phone is locked, or the user signed out.

## 1. Root cause analysis (before migration 034)

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | Phone does not ring (Gagan → Smita and Smita → Gagan) | The call push was the generic notification push: tag `notif_<id>`, actions "Open / Dismiss", **24 h TTL**, no re-alert. Nothing closed it when the call ended. | Dedicated call push (`PushService.sendCall`): Answer / Decline actions, `requireInteraction`, ring vibration, TTL = time left to ring, re-sent every 10 s with `renotify` so the phone alerts again, and replaced by "Missed call from X" or closed on cancel / answer elsewhere. |
| 2 | Phone does not ring when the app was recently open | `call:incoming` was emitted once over the socket. A phone whose socket is reconnecting (screen was off) loses the event and nothing ever re-checks. | `GET /api/calls/pending` is checked on every socket (re)connect, on return to foreground and when a ring push arrives. |
| 3 | Callee shows **busy** for hours | When a socket dropped mid-call the server only emitted `call:ended`; the DB row stayed `active` until the 4-hour sweep, and `activeCallForEmployee` reported the user busy. | Disconnect → `call:peer_left {reason:'reconnecting'}` and a 20 s grace timer; rejoin cancels it, otherwise the call is closed in the DB (`end_reason = disconnected`). |
| 4 | Call "connects" but there is no audio, or it stays on "Connecting…" | Race: the caller sent the WebRTC offer on `call:accepted`, which arrives **before** the callee has joined the signalling room, so the offer was dropped; `offerSentRef` then blocked any resend. | Caller offers only when the callee is in the room (`call:peer_joined` / join ack). After a reconnect either side rejoins and the caller renegotiates with an ICE restart. |
| 5 | Ringing depended on the caller's browser | The 45 s timeout and "missed" logic ran in the caller's tab; closing it left the callee ringing until the 60 s sweep. | Server-driven ringing in `CallService` (push, re-ring, expire at 45 s, missed notification). |
| 6 | No chat notification on the phone | Chat pushes were sent only to members with **no socket at all** (`isOnline`). A PWA in the background, a locked phone, or a desktop tab left open elsewhere keeps a socket, so the phone got nothing. | Push to every member without a **foreground** page. Pages report `client:visibility`; `hasVisibleClient()` decides. |
| 7 | Push stops working for everyone after a restart / redeploy | VAPID keys come from `storage/config/vapid.json`. If that file is not writable, every call to `config.vapidPublicKey` generated a **new** key pair; if it is wiped on deploy, all subscriptions break. Push services answer 403 forever, and nothing re-subscribed. | Keys memoised; `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` documented in env; the client re-subscribes when the server key changes; 403 key mismatch removes the subscription. |
| 8 | Nothing after sign-out | Mobile sign-out deleted FCM tokens and delivery required a live session. | Sign-out asks "Keep call and message notifications on this device" (default on). Devices that keep them get pushes without message text. |
| 9 | Tapping a notification with the app open did nothing | The worker posted `NAVIGATE`, but no code listened for `sw:navigate`. | `ServiceWorkerBridge` in `App.tsx`; call taps post `CALL_ACTION` to answer without reloading. |
| 10 | Messages typed offline were lost on reload | Failed messages lived only in React state. | Persistent outbox (`lib/outbox.ts`), retried on `online`, on reconnect and every 20 s; the server dedupes by `clientId`. |
| 11 | Deleting a message deleted it for everyone | Only "delete for everyone" existed. | "Delete for me" (`message_hidden`), and per-side soft delete for call history (`caller_deleted_at` / `callee_deleted_at`). |

## 2. How it works now

```
Caller A                      Server                                   Callee B (all devices)
POST /calls/start  ───────►  calls row 'ringing'
                              ├─ socket  call:incoming  ─────────────► open app: full-screen ring + looping ringtone
                              ├─ Web Push call_ring (TTL ≤45 s, urgency high) ► service worker: Answer / Decline notification
                              ├─ FCM high priority, channel "calls" ───► Capacitor app
                              └─ every 10 s: re-ring push (renotify)
               B answers ─►  status 'active' ─ call_cancel push to B's other devices
                              caller offers once B is in call room (WebRTC via STUN/TURN)
  no answer in 45 s ──────►  status 'missed', end_reason no_answer ─ "Missed call from A" replaces the ring
```

Call states: `ringing`, `active`, `completed`, `declined`, `missed` (end_reason `no_answer` / `cancelled`),
`busy`. The history shows "No answer", "Cancelled", "Missed", "Declined", "Busy", "Dropped" from each user's side.

Notification Decline / swipe-away is sent by the service worker to `POST /api/calls/push-action`,
authorised by an HMAC token bound to that call and callee, so it works when signed out too.

Every push attempt is written to `push_delivery_log` (`sent` → `delivered` when the service worker
displays it; `failed` / `expired` otherwise). Read it with `GET /api/push/log` (own) or
`GET /api/push/log/:employeeId` (requires `notifications.manage`).

## 3. Setup

### HTTPS
Service workers, Web Push, microphone and camera only work on HTTPS (or `localhost`). Serve the site
over HTTPS (see `NGINX_REVERSE_PROXY.md`); the WebSocket must be proxied on the same origin
(`/socket.io`, `Upgrade` headers).

### Web Push (VAPID)
```bash
npx web-push generate-vapid-keys
```
Put both values in the backend environment and **never change them**:
```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```
Without them the server generates `backend/storage/config/vapid.json`. That works only if the directory
is writable and survives redeploys.

### Firebase Cloud Messaging (Capacitor app only)
Set `FCM_SERVICE_ACCOUNT_FILE` or `FCM_SERVICE_ACCOUNT_JSON` (see `MOBILE_APP.md`). The app must create
the Android notification channel `calls` with high importance and a ringtone sound.

### TURN server (coturn)
Without TURN, calls fail between phones on mobile data / strict NATs (no audio). On a VPS with a public IP:

```bash
sudo apt install coturn
```
`/etc/turnserver.conf`:
```
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret            # or: lt-cred-mech + user=bscturn:STRONG_PASSWORD
static-auth-secret=CHANGE_ME_LONG_RANDOM
realm=turn.example.com
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
external-ip=PUBLIC_IP
min-port=49152
max-port=65535
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```
Open UDP/TCP 3478, TCP 5349, UDP 49152-65535. Backend env (static user variant):
```
TURN_URL=turns:turn.example.com:5349
TURN_USERNAME=bscturn
TURN_CREDENTIAL=STRONG_PASSWORD
STUN_URLS=stun:turn.example.com:3478,stun:stun.l.google.com:19302
```
Verify with https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ (a `relay` candidate must appear).

### Database
`npm run db:migrate` applies `034_push_calls_reliability.sql` (additive only; it runs automatically on boot).

## 4. Platform limits

| Platform | Behaviour |
|----------|-----------|
| **Android Chrome / installed PWA** | Full support: push while closed / locked, Answer / Decline buttons, re-ring every 10 s (sound + vibration each time), "Missed call" replacement. Uses the default notification sound: a web page cannot play a looping ringtone while closed. Battery optimisation ("Restricted") can delay pushes: set the browser to "Unrestricted". |
| **iOS / iPadOS** | Web Push only for apps **added to the Home Screen** (iOS 16.4+); the banner tells Safari users how. No action buttons on most versions (tapping opens the call screen), no vibration pattern, no full-screen ring when locked, no looping ringtone: each re-ring push gives one alert. Focus modes can silence it. |
| **Desktop browsers** | Push works while the browser is running (Chrome / Edge also with no tab open, if "continue running background apps" is on). |
| **Signed out (kept on)** | Calls ring; chat shows "New message · sign in to read it". Answering requires signing in. |

A web app cannot draw a full-screen call UI over the lock screen or ring continuously like a phone
call. That requires a native wrapper.

### Native-style ringing (recommended next step)
The repo already ships a Capacitor shell (`frontend/ios`, `@capacitor/*`). For real phone-call behaviour:

- **Android**: send FCM **data-only, high-priority** messages for `call_ring` (no `notification` block),
  handle them in a `FirebaseMessagingService`, and show a `CallStyle` notification with a
  full-screen intent (`USE_FULL_SCREEN_INTENT` permission) or register with
  `ConnectionService` / `TelecomManager` (self-managed). This rings over the lock screen with the
  system ringtone until answered or cancelled by the `call_cancel` message.
- **iOS**: register a **VoIP push** (PushKit) token, send `call_ring` through APNs with
  `apns-push-type: voip`, and report it to **CallKit** (`CXProvider.reportNewIncomingCall`) in the
  PushKit handler. This gives the native full-screen incoming-call UI. Apple requires every VoIP push
  to be reported to CallKit.
- Plugins: `@capacitor-firebase/messaging` plus a CallKit / ConnectionService plugin such as
  `capacitor-plugin-callkit-voip`, or a small custom plugin. The server side already has
  `PushService.sendCall`; add a `voip` token type next to `push_device_tokens`.

## 5. Test plan

Prepare two phones: **Gagan** (Android, Chrome, PWA installed) and **Smita** (Android or iPhone with
the PWA on the Home Screen). Both are signed in and have tapped "Turn on notifications". Configure TURN.
After each step, check `GET /api/push/log` for the receiver (`sent` → `delivered`).

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | App open, Gagan → Smita | Gagan calls Smita (audio) | Smita: full-screen ring + looping ringtone within 1-2 s. Gagan hears ringback. Answer → two-way audio, timer runs on both sides. |
| 2 | App open, Smita → Gagan | Same in reverse, then video | Same; video both ways. |
| 3 | Background | Smita presses Home; Gagan calls | Notification "Gagan · Incoming voice call" with Answer / Decline, sound + vibration repeating about every 10 s. Answer opens the app and connects. |
| 4 | App closed | Swipe the PWA away from recents; call | Same as 3. Decline from the notification: Gagan sees "Call declined" immediately. |
| 5 | Phone locked | Lock Smita's phone; call | Lock-screen notification rings and repeats; Answer → unlock → connects. |
| 6 | No answer | Let it ring | At 45 s the ring is replaced by "Missed call from Gagan"; Gagan sees "No answer"; both histories updated. |
| 7 | Caller cancels | Gagan hangs up at 10 s | Smita's ring is replaced by "Missed call"; history: Gagan "Cancelled", Smita "Missed". |
| 8 | Busy | Smita is in a call with a third user; Gagan calls | Gagan: "Smita is on another call"; both histories show Busy. |
| 9 | Two devices | Smita signed in on phone and laptop; answer on the laptop | Phone stops ringing (call_cancel). |
| 10 | Signed out | Smita signs out with "Keep notifications" ticked; Gagan calls and sends a message | Call rings; message shows "Gagan · New message · sign in to read it". Repeat with the box unticked: nothing arrives. |
| 11 | Chat | Smita's app in background / closed / locked; Gagan sends 3 messages | One notification "Gagan (3)" with the latest text, sound each time; tap opens that chat. App open on that chat: no notification, in-app tone only. |
| 12 | Network drop mid-call | Turn on airplane mode on Smita for 5 s, then off | Gagan sees "Smita is reconnecting…"; audio resumes (ICE restart). If off for more than 20 s, both see "call ended" and the history shows "Dropped". |
| 13 | No internet then reconnect (chat) | Smita offline sends 2 messages, reloads the app, goes online | Messages stay "sending"; delivered automatically after reconnect, once each. |
| 14 | No internet then reconnect (call) | Smita offline while Gagan calls (ring under 45 s), then online | If still ringing: the ring appears on reconnect (pending check). Otherwise "Missed call from Gagan". |
| 15 | Expired subscription | In browser site settings, reset notification permission for Smita; send a message | Log shows `expired` (410/404) and the row is removed; after re-allowing, opening the app re-registers. |
| 16 | Permission denied | Block notifications | Amber banner explains calls ring only while the app is open and how to re-enable. |
| 17 | History persistence | Sign in as Smita on another device | Same chat and call history. "Delete for me" on a message or call removes it only for Smita. |
