import type { CapacitorConfig } from '@capacitor/cli';

/**
 * BSC Workforce mobile app (Android / iOS), built from this web app.
 * See docs/MOBILE_APP.md. The app talks to the live API
 * (VITE_MOBILE_API_ORIGIN, default https://emptrack.bsctextiles.in).
 *
 * appId is permanent once the app is published to a store.
 */
const config: CapacitorConfig = {
  appId: 'in.bsctextiles.workforce',
  appName: 'BSC Workforce',
  webDir: 'dist',
  // Never load remote code into the app shell; only the bundled build runs.
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    SplashScreen: {
      // Hidden by the app as soon as the session check finishes; 6 s is only a safety net.
      launchAutoHide: true,
      launchShowDuration: 6000,
      backgroundColor: '#1d4ed8',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: false,
      splashImmersive: false,
    },
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
    Keyboard: {
      resizeOnFullScreen: true,
    },
  },
};

export default config;
