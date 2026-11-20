package in.bsctextiles.workforce.calls;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.telecom.CallAudioState;
import android.telecom.DisconnectCause;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.util.Log;
import androidx.core.content.ContextCompat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Android Telecom integration (self-managed ConnectionService, Android 8+).
 *
 * Registering the call with Telecom tells Android that a real call is ringing: other apps' audio
 * is paused, the call can be answered from a Bluetooth headset or car, an ongoing mobile-network
 * call is handled correctly, and the system gives the app call-audio routing. The ringing UI itself
 * is still the app's own (CallStyle notification + IncomingCallActivity), as Telecom requires for
 * self-managed apps. When Telecom is unavailable or refuses, the notification path is used alone.
 */
public final class TelecomBridge {
    private static final String TAG = "BscTelecom";
    private static final String ACCOUNT_ID = "bsc_workforce_calls";
    static final String EXTRA_INFO = "bsc_call_info";

    private static final Map<String, BscConnectionService.BscConnection> CONNECTIONS = new ConcurrentHashMap<>();
    private static final Map<String, Boolean> UI_SHOWN = new ConcurrentHashMap<>();
    private static volatile boolean registered;

    private TelecomBridge() {}

    static boolean supported(Context ctx) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELECOM)
            && ContextCompat.checkSelfPermission(ctx, Manifest.permission.MANAGE_OWN_CALLS) == PackageManager.PERMISSION_GRANTED;
    }

    static PhoneAccountHandle handle(Context ctx) {
        return new PhoneAccountHandle(new ComponentName(ctx, BscConnectionService.class), ACCOUNT_ID);
    }

    public static void register(Context ctx) {
        if (registered || !supported(ctx)) return;
        try {
            TelecomManager tm = ctx.getSystemService(TelecomManager.class);
            if (tm == null) return;
            PhoneAccount account = PhoneAccount.builder(handle(ctx), "BSC Workforce")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .addSupportedUriScheme("bsc")
                .build();
            tm.registerPhoneAccount(account);
            registered = true;
        } catch (Exception e) {
            Log.w(TAG, "phone account registration failed", e);
        }
    }

    /** Returns true when Telecom accepted the incoming call (it will call onShowIncomingCallUi). */
    public static boolean addIncomingCall(Context ctx, CallInfo info) {
        if (!supported(ctx)) return false;
        register(ctx);
        try {
            TelecomManager tm = ctx.getSystemService(TelecomManager.class);
            if (tm == null) return false;
            PhoneAccountHandle h = handle(ctx);
            if (!tm.isIncomingCallPermitted(h)) return false;
            Bundle callExtras = new Bundle();
            callExtras.putBundle(EXTRA_INFO, info.toBundle());
            Bundle extras = new Bundle();
            extras.putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, Uri.fromParts("bsc", info.callerCode.isEmpty() ? info.callerId : info.callerCode, null));
            extras.putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, callExtras);
            tm.addNewIncomingCall(h, extras);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "addNewIncomingCall failed; using the notification only", e);
            return false;
        }
    }

    static void onConnectionCreated(String callId, BscConnectionService.BscConnection connection) {
        CONNECTIONS.put(callId, connection);
    }

    static void onUiShown(String callId) {
        UI_SHOWN.put(callId, Boolean.TRUE);
    }

    static boolean uiShown(String callId) {
        return UI_SHOWN.containsKey(callId);
    }

    static void forget(String callId) {
        CONNECTIONS.remove(callId);
        UI_SHOWN.remove(callId);
    }

    /** Answered (our screen, notification, headset or car): Telecom moves the call to active and gives it call audio. */
    static void markAnswering(String callId) {
        BscConnectionService.BscConnection c = CONNECTIONS.get(callId);
        if (c != null && c.getState() == android.telecom.Connection.STATE_RINGING) c.setActive();
    }

    /** WebRTC is connected in the app. */
    public static void setActive(String callId) {
        BscConnectionService.BscConnection c = CONNECTIONS.get(callId);
        if (c != null) c.setActive();
    }

    public static void endCall(String callId, String reason) {
        BscConnectionService.BscConnection c = CONNECTIONS.remove(callId);
        UI_SHOWN.remove(callId);
        if (c == null) return;
        int code;
        switch (reason == null ? "" : reason) {
            case "declined": code = DisconnectCause.REJECTED; break;
            case "missed":
            case "timeout": code = DisconnectCause.MISSED; break;
            case "cancelled": code = DisconnectCause.CANCELED; break;
            case "answered_elsewhere": code = DisconnectCause.ANSWERED_ELSEWHERE; break;
            case "remote": code = DisconnectCause.REMOTE; break;
            default: code = DisconnectCause.LOCAL;
        }
        c.finish(new DisconnectCause(code));
    }

    /** Audio route of the active Telecom call, or null when there is none. */
    static BscConnectionService.BscConnection active() {
        for (BscConnectionService.BscConnection c : CONNECTIONS.values()) {
            if (c.getState() == android.telecom.Connection.STATE_ACTIVE) return c;
        }
        return null;
    }

    /** Routes call audio: "earpiece", "speaker", "bluetooth" or "wired". Returns false without a Telecom call. */
    @SuppressWarnings("deprecation")
    static boolean setAudioRoute(String route) {
        BscConnectionService.BscConnection c = active();
        if (c == null) return false;
        int r;
        switch (route) {
            case "speaker": r = CallAudioState.ROUTE_SPEAKER; break;
            case "bluetooth": r = CallAudioState.ROUTE_BLUETOOTH; break;
            case "wired": r = CallAudioState.ROUTE_WIRED_HEADSET; break;
            default: r = CallAudioState.ROUTE_EARPIECE;
        }
        c.setAudioRoute(r);
        return true;
    }
}
