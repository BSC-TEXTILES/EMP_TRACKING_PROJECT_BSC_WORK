package in.bsctextiles.workforce.calls;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.WindowManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;
import java.util.List;
import java.util.Map;

/**
 * Bridge between the web app (CallInterface.tsx via lib/nativeCalls.ts) and the native call layer.
 *
 * Events to JS ("callAction"): answer / declined / hangup, raised by the lock-screen call screen,
 * the ringing or ongoing-call notification, a Bluetooth headset or a car. Actions that happen while
 * the WebView is not running are kept and returned by getLaunchAction() when the app starts.
 */
@CapacitorPlugin(name = "CallBridge")
public class CallBridgePlugin extends Plugin {
    private static WeakReference<CallBridgePlugin> instance = new WeakReference<>(null);
    private static JSObject pendingAction;
    private static final Object LOCK = new Object();

    @Override
    public void load() {
        instance = new WeakReference<>(this);
        CallManager.ensureChannels(getContext());
        TelecomBridge.register(getContext());
    }

    // ------------------------------------------------------------------ native → JS

    /** Called by native code. Delivered at once when the web app is running, else kept for getLaunchAction(). */
    public static void queueAction(Context ctx, String action, String callId) {
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("callId", callId);
        data.put("at", System.currentTimeMillis());
        CallBridgePlugin plugin = instance.get();
        if (plugin != null && plugin.getBridge() != null && plugin.hasListeners("callAction")) {
            plugin.notifyListeners("callAction", data, true);
            return;
        }
        synchronized (LOCK) {
            pendingAction = data;
        }
    }

    /** An FCM call message while the web app runs: lets it react immediately (it ignores duplicates). */
    public static void forwardPush(Map<String, String> data) {
        CallBridgePlugin plugin = instance.get();
        if (plugin == null || plugin.getBridge() == null) return;
        JSObject payload = new JSObject();
        for (Map.Entry<String, String> e : data.entrySet()) {
            if (!"actionToken".equals(e.getKey())) payload.put(e.getKey(), e.getValue());
        }
        plugin.notifyListeners("callPush", payload, false);
    }

    /** MainActivity forwards launch / new intents (Answer tapped while the app was closed). */
    public static void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra(CallManager.EXTRA_CALL_ACTION);
        String callId = intent.getStringExtra(CallManager.EXTRA_CALL_ID);
        if (CallManager.ACTION_ANSWER.equals(intent.getAction()) && action == null) action = "answer";
        if (action == null || callId == null) return;
        CallBridgePlugin plugin = instance.get();
        Context ctx = plugin != null ? plugin.getContext() : null;
        if (ctx != null && "answer".equals(action)) {
            // The notification's Answer button opens the app directly: stop the ring here as well.
            CallInfo ringing = CallManager.currentRinging();
            if (ringing != null && ringing.callId.equals(callId)) CallManager.answer(ctx, ringing, false);
            else queueAction(ctx, action, callId);
            return;
        }
        if (ctx != null) queueAction(ctx, action, callId);
        else synchronized (LOCK) {
            JSObject data = new JSObject();
            data.put("action", action);
            data.put("callId", callId);
            pendingAction = data;
        }
    }

    // ------------------------------------------------------------------ JS → native

    @PluginMethod
    public void configure(PluginCall call) {
        CallManager.setApiOrigin(getContext(), call.getString("apiOrigin"));
        String token = call.getString("fcmToken");
        if (token != null) CallManager.setFcmToken(getContext(), token);
        call.resolve();
    }

    @PluginMethod
    public void getLaunchAction(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (LOCK) {
            if (pendingAction != null) {
                long at = pendingAction.optLong("at", System.currentTimeMillis());
                // Only recent actions: an "answer" from minutes ago is for a call that is long over.
                if (System.currentTimeMillis() - at < 60_000) result.put("action", pendingAction);
                pendingAction = null;
            }
        }
        call.resolve(result);
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        Context ctx = getContext();
        JSObject result = new JSObject();
        result.put("nativeCalls", true);
        result.put("notifications", CallManager.notificationsAllowed(ctx));
        result.put("fullScreenIntent", CallManager.canUseFullScreenIntent(ctx));
        result.put("telecom", TelecomBridge.supported(ctx));
        result.put("sdk", Build.VERSION.SDK_INT);
        result.put("manufacturer", Build.MANUFACTURER);
        result.put("model", Build.MODEL);
        call.resolve(result);
    }

    /** Android 14+: "Allow full-screen notifications" for this app, otherwise the app's notification settings. */
    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        Context ctx = getContext();
        Intent intent;
        if (Build.VERSION.SDK_INT >= 34) {
            intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + ctx.getPackageName()));
        } else {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName());
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(intent);
        } catch (Exception e) {
            ctx.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    /** Battery optimisation list, where the user can set the app to "Unrestricted" so pushes are not delayed. */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        try {
            getContext().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            getContext().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    /** The web app showed / answered / ended the ring itself: stop the native ring on this phone. */
    @PluginMethod
    public void dismissIncoming(PluginCall call) {
        String callId = call.getString("callId");
        String reason = call.getString("reason", "local");
        if (callId != null) {
            if ("answered".equals(reason)) {
                CallInfo ringing = CallManager.currentRinging();
                if (ringing != null && ringing.callId.equals(callId)) {
                    // Answered inside the app: Telecom keeps the call, only the ring stops.
                    CallManager.answer(getContext(), ringing, false);
                } else {
                    TelecomBridge.markAnswering(callId);
                }
            } else {
                CallManager.finish(getContext(), callId, reason);
            }
        }
        call.resolve();
    }

    /** A call is connected in the app: foreground service (mic in background), screen over lock, call audio mode. */
    @PluginMethod
    public void callStarted(PluginCall call) {
        String callId = call.getString("callId", "");
        String peerName = call.getString("peerName", "Colleague");
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
        OngoingCallService.start(getContext(), callId, peerName, System.currentTimeMillis(), video);
        TelecomBridge.setActive(callId);
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am != null && TelecomBridge.active() == null) am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        setOverLockScreen(true);
        call.resolve();
    }

    @PluginMethod
    public void callEnded(PluginCall call) {
        String callId = call.getString("callId", "");
        OngoingCallService.stop(getContext());
        TelecomBridge.endCall(callId, call.getString("reason", "local"));
        CallManager.finish(getContext(), callId, "ended");
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
            else {
                am.setSpeakerphoneOn(false);
                if (am.isBluetoothScoOn()) {
                    am.stopBluetoothSco();
                    am.setBluetoothScoOn(false);
                }
            }
            am.setMode(AudioManager.MODE_NORMAL);
        }
        setOverLockScreen(false);
        call.resolve();
    }

    private void setOverLockScreen(boolean on) {
        Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 27) {
                activity.setShowWhenLocked(on);
                activity.setTurnScreenOn(on);
            } else if (on) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
            }
            if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    /** Available call audio outputs: earpiece, speaker, bluetooth, wired. */
    @PluginMethod
    public void getAudioRoutes(PluginCall call) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        JSArray routes = new JSArray();
        String current = "earpiece";
        boolean bluetooth = false;
        boolean wired = false;
        if (am != null) {
            for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                int t = d.getType();
                if (t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || (Build.VERSION.SDK_INT >= 31 && t == AudioDeviceInfo.TYPE_BLE_HEADSET)) bluetooth = true;
                if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || t == AudioDeviceInfo.TYPE_USB_HEADSET) wired = true;
            }
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo dev = am.getCommunicationDevice();
                if (dev != null) current = routeName(dev.getType());
            } else if (am.isSpeakerphoneOn()) {
                current = "speaker";
            } else if (am.isBluetoothScoOn()) {
                current = "bluetooth";
            }
        }
        routes.put(wired ? "wired" : "earpiece");
        routes.put("speaker");
        if (bluetooth) routes.put("bluetooth");
        JSObject result = new JSObject();
        result.put("routes", routes);
        result.put("current", current);
        call.resolve(result);
    }

    private static String routeName(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "speaker";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case 26 /* TYPE_BLE_HEADSET */: return "bluetooth";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET: return "wired";
            default: return "earpiece";
        }
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void setAudioRoute(PluginCall call) {
        String route = call.getString("route", "earpiece");
        if (TelecomBridge.setAudioRoute(route)) {
            call.resolve(new JSObject().put("route", route).put("via", "telecom"));
            return;
        }
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) {
            call.reject("Audio routing is not available");
            return;
        }
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        boolean ok = false;
        if (Build.VERSION.SDK_INT >= 31) {
            List<AudioDeviceInfo> devices = am.getAvailableCommunicationDevices();
            for (AudioDeviceInfo d : devices) {
                if (route.equals(routeName(d.getType()))) {
                    ok = am.setCommunicationDevice(d);
                    break;
                }
            }
            if (!ok && "earpiece".equals(route)) {
                am.clearCommunicationDevice();
                ok = true;
            }
        } else {
            if ("bluetooth".equals(route)) {
                am.setSpeakerphoneOn(false);
                am.startBluetoothSco();
                am.setBluetoothScoOn(true);
            } else {
                if (am.isBluetoothScoOn()) {
                    am.stopBluetoothSco();
                    am.setBluetoothScoOn(false);
                }
                am.setSpeakerphoneOn("speaker".equals(route));
            }
            ok = true;
        }
        if (ok) call.resolve(new JSObject().put("route", route).put("via", "audio_manager"));
        else call.reject("That audio output is not connected");
    }
}
