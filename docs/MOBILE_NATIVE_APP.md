# BSC Workforce native app (Android / iOS)

The Android and iOS apps are the website, packaged with Capacitor 8. One codebase: every screen,
permission and fix on the website is in the app. API and push details: `docs/MOBILE_BACKEND.md`.

```
frontend/
  capacitor.config.ts          app id in.bsctextiles.workforce, name "BSC Workforce"
  android/                     Android Studio project (generated, committed)
  ios/                         Xcode project (generated, committed; Swift Package Manager)
  scripts/generate-app-assets.mjs   icons + splash from public/icons/icon.svg
  src/lib/native.ts            platform detection, secure token storage, media URLs
  src/lib/theme.ts             light / dark / follow device
  src/components/mobile/       NativeShell (splash, back button, offline, pull to refresh), BottomNav
```

## Build and run

Needs: Node 20+, **JDK 21** and **Android Studio** (Android); a **Mac with Xcode 16+** (iOS).

```bash
cd frontend
npm run mobile:sync        # build the web app and copy it into android/ and ios/
npm run mobile:android     # opens Android Studio -> Run on a phone or emulator
npm run mobile:ios         # (Mac) opens Xcode -> pick a team under Signing -> Run
```

- The app calls `https://emptrack.bsctextiles.in`. For a staging server build with
  `VITE_MOBILE_API_ORIGIN=https://staging.example.com npm run mobile:sync`.
- The server must have migrations 032 applied and `MOBILE_APP_ORIGINS` left at its default
  (`capacitor://localhost,https://localhost`).
- New icon or splash artwork: replace `public/icons/icon.svg`, then `npm run mobile:assets`.
- Run `npm run mobile:sync` after every web change you want in the app.

## What the app does differently from the website

| Area | App behaviour |
|---|---|
| Sign-in | Token sign-in (`/api/auth/mobile/*`). Tokens live in the Android Keystore / iOS Keychain, never in web storage. Stays signed in for the server session length (7 days). Android cloud backup is off so tokens never move to another phone. |
| Images, files, exports | Loaded with a 1-hour media link (`?mt=`) that only works for file downloads and exports and dies with the session. Downloads and exports open in the in-app browser. |
| Real-time (chat, calls, alerts) | WebSocket with the access token; refreshed automatically on reconnect. |
| Navigation | Bottom tab bar (Home, Attendance, Tasks, Messages, or the first four the user can open) + **More** for the full menu. Android back button closes dialogs, then goes back, then leaves the app in the background. |
| Pull to refresh | Pull down at the top of any screen to reload it. |
| No internet | Full-screen "No internet connection" with Try again; disappears by itself when the connection returns. A dropped signal never signs the user out. |
| Splash / status bar | Blue splash until the session check finishes; status-bar icons follow the theme. Safe areas (notch, home indicator) are respected. |
| Theme | Follows the phone's light/dark setting; Settings → Appearance → Theme to fix it. (The website now has the same option, default light.) |
| Activity monitoring | Not started from a phone (a phone cannot report desktop activity). |

## Not in this stage

- Push notifications on the phone (permission prompt, token registration, tapping opens the screen) —
  stage 3. The server side is ready.
- No billing (internal staff app).
- Offline use: screens need a connection; nothing is queued while offline.
- Release signing, store listings and private distribution — stage 4.

## Checked

- Web build, TypeScript, `cap sync` for both platforms; screens at phone size in light and dark.
- Back end: `tests/mobile-push.test.ts`, `tests/mobile-media.test.ts`, `tests/office-hours-groups.test.ts` (22 tests).
- **Not yet run on a real phone or emulator** (no Android SDK / Mac on the build machine). First run
  on a device is the next check.
