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
`npm run db:migrate` applies `034_push_calls_reliability.sql` and `039_call_reachability_native.sql` (additive only; they run automatically on boot). Manual rollback for 039: `database/rollback/039_call_reachability_native.down.sql`.

## 4. Platform limits

| Platform | Behaviour |
|----------|-----------|
| **Android Chrome / installed PWA** | Full support: push while closed / locked, Answer / Decline buttons, re-ring every 10 s (sound + vibration each time), "Missed call" replacement. Uses the default notification sound: a web page cannot play a looping ringtone while closed. Battery optimisation ("Restricted") can delay pushes: set the browser to "Unrestricted". |
| **iOS / iPadOS** | Web Push only for apps **added to the Home Screen** (iOS 16.4+); the banner tells Safari users how. No action buttons on most versions (tapping opens the call screen), no vibration pattern, no full-screen ring when locked, no looping ringtone: each re-ring push gives one alert. Focus modes can silence it. |
| **Desktop browsers** | Push works while the browser is running (Chrome / Edge also with no tab open, if "continue running background apps" is on). |
| **Signed out (kept on)** | Calls ring; chat shows "New message · sign in to read it". Answering requires signing in. |

A web app cannot draw a full-screen call UI over the lock screen or ring continuously like a phone
call. The Android app does this natively (below).

### Android app: native ringing (migration 039)
The Android app no longer depends on a notification for calls. It rings like a phone call:

| Piece | File | What it does |
|-------|------|--------------|
| FCM entry point | `calls/CallMessagingService.java` | The app's only FCM service (replaces the Capacitor plugin's in the manifest). Call messages are handled natively; everything else goes to the Capacitor push plugin unchanged. |
| Ring logic | `calls/CallManager.java` | `call_ring` → CallStyle notification with a **full-screen intent**, looping ringtone + vibration (`FLAG_INSISTENT`), Telecom registration, delivery receipt to `/api/calls/ring-ack`. `call_cancel` / `call_missed` stop the ring (and show "Missed call from X"). Duplicate / late pushes for a finished call are ignored. |
| Lock-screen screen | `calls/IncomingCallActivity.java` | Full-screen call over the lock screen: initials / photo, name, employee ID · designation, location chip (BEL / DAV / SHI / HQ), animated rings, Decline / Answer. Turns the screen on. |
| Telecom | `calls/TelecomBridge.java`, `calls/BscConnectionService.java` | Self-managed `ConnectionService` (Android 8+): answer / hang up from a Bluetooth headset or car, other apps' audio paused, system call-audio routing. Falls back to the notification alone if Telecom refuses. |
| Ongoing call | `calls/OngoingCallService.java` | Microphone foreground service while connected, so audio keeps working when the phone is locked or another app is opened. Ongoing-call notification with timer and Hang up. |
| Web bridge | `calls/CallBridgePlugin.java` ↔ `src/lib/nativeCalls.ts` | Answer / Decline / Hang up events to the web app (also an Answer tapped while the app was closed), stop the native ring when the web app answers, audio routes (phone / speaker / Bluetooth / headphones), capability checks, settings shortcuts. |

The server sends **data-only, high-priority** FCM messages to app builds that registered with
`nativeCalls: true` (`push_device_tokens.native_calls`). Older app builds keep receiving the previous
notification pushes, so nothing breaks while people update.

**Android permissions.** The ring needs notification permission (Android 13+ asks). Full-screen over the
lock screen needs "Use full-screen intents": Android 14+ grants it automatically only to calling apps
installed from Play with the calling declaration, otherwise the user enables it (the Calls page shows a
banner with a button that opens the setting). Without it the call still rings as a heads-up notification
with Answer / Decline. Battery optimisation "Restricted" can delay pushes; the Calls page links to it.

**Firebase setup (required for the app to ring while closed).**
1. Firebase console → project → add an Android app with package `in.bsctextiles.workforce`.
2. Download `google-services.json` to `frontend/android/app/google-services.json` (the build applies the
   Google Services plugin only when this file exists; without it the app builds but cannot receive FCM).
3. Firebase console → Project settings → Service accounts → generate a key, and set
   `FCM_SERVICE_ACCOUNT_FILE` (or `FCM_SERVICE_ACCOUNT_JSON`) on the backend.
4. Build: `cd frontend && npm run build && npx cap sync android && cd android && ./gradlew assembleRelease`
   (JDK 17 or 21; Gradle 8.14 does not run on JDK 25).

**Debug-only test hook.** Debug builds contain `src/debug/.../DebugCallReceiver.java`, which feeds a fake
call push into the same code path FCM uses (no server is contacted):
```bash
adb shell am broadcast -a in.bsctextiles.workforce.DEBUG_CALL -p in.bsctextiles.workforce \
  --es type call_ring --es callId t1 --es callerName "'Gagan C B'" --es callerCode EMP-1001 \
  --es callerDesignation "'Store Manager'" --es callerLocationCode BEL --es callerLocationName Belagavi
adb shell am broadcast -a in.bsctextiles.workforce.DEBUG_CALL -p in.bsctextiles.workforce --es type call_cancel --es callId t1
```

**iOS** still uses standard push (no CallKit / PushKit yet). That needs an Apple VoIP push certificate and
a CallKit plugin; the server side would add a `voip` token type next to `push_device_tokens`.

## 4a. Honest call states and reachability (migration 039)

The caller's screen never shows a fake "Ringing":

```
POST /calls/start ── no live connection AND no registered device ──► "User is offline or unreachable" (immediately)
        │
        ▼ state "calling" (screen: Calling…, no ringback)
  a device confirms ── socket call:ring_ack (open app) ──────────┐
                     ── service-worker push receipt (/push/ack) ─┼─► calls.delivered_at, caller gets call:ringing (screen: Ringing…, ringback)
                     ── native Android receipt (/calls/ring-ack) ┘
  no confirmation in CALL_UNREACHABLE_SECONDS (12 s) ──► status 'unreachable'
        end_reason 'offline'            (seen in the last 3 min: lost internet)  → "User is offline or unreachable"
        end_reason 'device_unavailable' (not seen recently: phone off)          → "User's device is unavailable"
        caller: call:unreachable + in-app "Call not connected" record
        callee: missed-call push queued for 24 h + call:missed_summary on the next connection
  ringing and not answered in CALL_RING_TIMEOUT_SECONDS (30 s) ──► 'missed' (no_answer)
  answered ── guarded UPDATE (one device wins) ──► 'active' (Connecting…), other devices: call:answered_elsewhere + call_cancel push
  WebRTC media connected ── POST /calls/:id/connected ──► calls.connected_at, call:connected (timer runs)
```

Devices on older builds that cannot confirm a ring never cause a false "unreachable"; with them the
caller sees "Calling…" until answered or the ring timeout.

User-facing states (`state` in `/calls/detail/:id` and `/calls/history`): `initiating`, `ringing`,
`connecting`, `connected`, `ended`, `busy`, `declined`, `missed`, `unreachable`, `failed`.
Every transition is logged to `call_events` (`GET /api/calls/:callId/events`).

| Env | Default | Meaning |
|-----|---------|---------|
| `CALL_RING_TIMEOUT_SECONDS` | 30 | Ring time before "missed" (15–120) |
| `CALL_UNREACHABLE_SECONDS` | 12 | Wait for a device receipt before "unreachable" (5 .. ring time − 3) |
| `CALL_RECONNECT_GRACE_SECONDS` | 20 | A participant whose network dropped may rejoin within this time |

### Call API
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/calls/config` | session | ICE servers, ring / unreachable / grace timings, `turnConfigured` |
| POST | `/api/calls/start` | session | `{targetEmployeeId, type}` → `{callId, state: calling\|unreachable, message?, peer, iceServers}`; 409 `busy` / `already_in_call` |
| GET | `/api/calls/pending` | session | Call ringing for me (checked on reconnect / resume) |
| POST | `/api/calls/:id/accept` | callee | `{deviceId}`; 409 `call_ended` if another device already answered |
| POST | `/api/calls/:id/reject` | callee | Decline |
| POST | `/api/calls/:id/cancel` | caller | Hang up before answer |
| POST | `/api/calls/:id/connected` | participant | WebRTC media connected |
| POST | `/api/calls/:id/end` | participant | `{reason?: 'failed'}`; returns server-measured duration |
| POST / GET | `/api/calls/:id/events` | participant | Client diagnostics (ICE restart, quality, mic denied, audio route) / audit trail |
| GET | `/api/calls/history` | session | History with `status`, `state`, `endReason` |
| POST | `/api/calls/ring-ack` | HMAC token | Native Android receipt `{callId, token, fcmToken?, device?}` → `{first, ringing}` |
| POST | `/api/calls/push-action` | HMAC token | Decline / missed from a notification while signed out |

Socket events to clients: `call:incoming`, `call:ringing`, `call:unreachable`, `call:accepted`,
`call:answered_elsewhere`, `call:connected`, `call:rejected`, `call:missed`, `call:ended`, `call:peer_left`,
`call:missed_summary`. From clients: `call:ring_ack`, `call:join`, `call:signal`, `call:leave`, `client:heartbeat`.
Every socket event re-checks that the authenticated employee is a participant; ids in requests are never trusted.

### Verification done (20 Nov 2026)
- Backend: `tests/call-reachability.test.ts` (real Socket.IO server): immediate unreachable + missed-call
  summary exactly once on reconnect; "Calling" → "Ringing" only after a device ack; answer on one device
  stops the other and a second answer gets 409; native receipt rejects forged / other-employee tokens;
  a silent device becomes unreachable after the window and never shows "ringing". 5/5 pass.
- Android (emulator, API 37, debug hook): CallStyle heads-up over another app with Decline / Answer;
  full-screen call screen with caller details; screen-off device woken by the call with the full-screen
  screen shown automatically; Decline stops the ring and the Telecom call; remote cancel closes the screen;
  Answer opens the app; missed-call notification; self-managed Telecom account registered; lint 0 errors.
- **Not yet verified, needs two real phones and the Firebase project:** FCM delivery to a closed app, the
  ring over a secured (PIN / pattern) keyguard, two-way audio between phones on mobile data (needs TURN),
  Bluetooth headset answer, OEM battery managers (Xiaomi, Oppo, Vivo, Samsung "deep sleep"). Use §5.

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
