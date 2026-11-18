# Mobile app back end (stage 1)

What the Android / iOS app (Capacitor) uses on the existing API. The website is unchanged.

## Sign-in

The app runs on its own origin (`capacitor://localhost` on iOS, `https://localhost` on Android), so the
website's `SameSite=Strict` cookies never reach the API. The app uses tokens instead, stored in the
iOS Keychain / Android Keystore, and sends `Authorization: Bearer <accessToken>`.

Lockout, OTP / MFA, session limits and refresh-token reuse detection are the same as on the website.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/auth/mobile/login` | `{identifier, password}` | `{user, accessToken, refreshToken, accessTokenExpiresAt}` or an OTP challenge |
| POST | `/api/auth/login/otp/send` | `{challenge}` | (shared with the website) |
| POST | `/api/auth/mobile/login/otp/verify` | `{challenge, code, method?}` | same as login |
| POST | `/api/auth/mobile/refresh` | `{refreshToken}` | new pair + `sessionExpiresAt`. The old refresh token is spent; reusing it signs the session out. |
| POST | `/api/auth/mobile/logout` | `{refreshToken}` (+ Bearer if still valid) | Ends the session and removes this phone's push tokens. |

- Access tokens last 15 minutes. Sessions last `SESSION_TTL_DAYS` (7 by default); the user signs in
  again after that.
- Desktop activity tracking is not started from a phone.
- Real-time (chat, calls, notifications): `io(API_URL, { transports: ['websocket'], auth: { token: accessToken } })`.

## CORS

Only for the origins in `MOBILE_APP_ORIGINS` (default `capacitor://localhost,https://localhost`), and
only for requests without cookies: no `Access-Control-Allow-Credentials` is sent, and a write from those
origins that carries cookies is refused (403). Other origins are unchanged.

## Push notifications (Firebase Cloud Messaging)

Every in-app notification (`NotificationService.notify`) is also pushed to the recipients' phones.
Announcements (`POST /api/notifications/announcements`, audience chosen on the server) therefore reach
phones too; this replaces FCM topics, so location/role changes and sign-outs take effect immediately.

| Method | Path | Body |
|---|---|---|
| POST | `/api/push/devices` | `{token, platform: 'android' \| 'ios', deviceName?, appVersion?}` – after login and on every FCM token refresh |
| DELETE | `/api/push/devices` | `{token}` – user turned notifications off |
| GET | `/api/push/devices` | this user's registered phones |
| GET / PUT | `/api/push/preferences` | `{categories: {chat: false, ...}}` – Settings toggles |

- A token belongs to the session that registered it. Logout, an admin revoking the session, or the
  employee being deactivated stops pushes at once. A token re-registered by another user moves to them.
- Tokens FCM reports as unregistered are deleted; a token failing 10 times in a row is dropped.
- Categories: tasks, chat, meetings, leave, tickets, reports, announcements, other. Muting affects
  push only; the notification is still in the app. Security alerts cannot be muted.
- Message data: `notificationId`, `type`, `category`, `link` (always an in-app path; anything else
  becomes `/notifications`). iOS badge = unread count.
- Android channels the app must create: `general`, `urgent`, `chat`, `calls`.

Setup: Firebase console → Project settings → Service accounts → Generate new private key. Put the file
on the server and set `FCM_SERVICE_ACCOUNT_FILE`, or put the JSON (raw or base64) in
`FCM_SERVICE_ACCOUNT_JSON`. Never commit it or ship it in the app. Without it, push is off and
everything else works.

Table: `push_device_tokens`, `notification_preferences` (migration 032).

## Also fixed

- `POST /api/push/send` was open to every signed-in user (anyone could push any text to anyone).
  It now needs `notifications.send`.

## Tests

`backend/tests/mobile-push.test.ts` (17 tests; Google endpoints are faked).
