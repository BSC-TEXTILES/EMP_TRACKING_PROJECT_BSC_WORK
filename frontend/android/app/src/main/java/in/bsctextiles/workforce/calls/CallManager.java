package in.bsctextiles.workforce.calls;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;
import in.bsctextiles.workforce.MainActivity;
import in.bsctextiles.workforce.R;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Native incoming-call handling for the BSC Workforce Android app.
 *
 * The server sends a data-only, high-priority FCM message for every call event, so this code runs
 * even when the app is closed, in the background or the phone is locked:
 *  - call_ring   → registers the call with Android Telecom (self-managed) when possible, and shows a
 *                  CallStyle notification with a full-screen intent: the IncomingCallActivity appears
 *                  over the lock screen, the ringtone loops (FLAG_INSISTENT) and the phone vibrates
 *                  until answered, declined, cancelled or the ring time is over. A delivery receipt is
 *                  sent to /api/calls/ring-ack so the caller's screen says "Ringing" only when it is true.
 *  - call_cancel → answered on another device / declined elsewhere: stop ringing here.
 *  - call_missed → stop ringing and show "Missed call from X".
 */
public final class CallManager {
    private static final String TAG = "BscCalls";

    public static final String CHANNEL_RING = "calls_ring_v2";
    public static final String CHANNEL_MISSED = "calls_missed";
    public static final String CHANNEL_ONGOING = "calls_ongoing";
    public static final String NOTIFICATION_TAG = "bsc_call";

    public static final String ACTION_ANSWER = "in.bsctextiles.workforce.call.ANSWER";
    public static final String ACTION_DECLINE = "in.bsctextiles.workforce.call.DECLINE";
    public static final String ACTION_HANGUP = "in.bsctextiles.workforce.call.HANGUP";
    public static final String ACTION_SHOW = "in.bsctextiles.workforce.call.SHOW";
    /** Sent to the IncomingCallActivity to close itself (call ended / answered elsewhere). */
    public static final String ACTION_CLOSE_UI = "in.bsctextiles.workforce.call.CLOSE_UI";

    public static final String EXTRA_CALL = "bsc_call";
    public static final String EXTRA_CALL_ID = "bsc_call_id";
    public static final String EXTRA_CALL_ACTION = "bsc_call_action";

    private static final String PREFS = "bsc_calls";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** Calls already finished on this phone (answered / declined / cancelled): a late or duplicate ring is ignored. */
    private static final Map<String, Long> FINISHED = new LinkedHashMap<String, Long>(32, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Long> eldest) {
            return size() > 50;
        }
    };

    private static volatile CallInfo ringing;

    private CallManager() {}

    // ----------------------------------------------------------------- configuration

    static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static String apiOrigin(Context ctx) {
        String saved = prefs(ctx).getString("apiOrigin", null);
        String origin = saved != null && saved.startsWith("https://") ? saved : ctx.getString(R.string.bsc_api_origin);
        return origin.endsWith("/") ? origin.substring(0, origin.length() - 1) : origin;
    }

    public static void setApiOrigin(Context ctx, String origin) {
        if (origin != null && origin.startsWith("https://")) prefs(ctx).edit().putString("apiOrigin", origin).apply();
    }

    public static void setFcmToken(Context ctx, String token) {
        if (token != null) prefs(ctx).edit().putString("fcmToken", token).apply();
    }

    public static CallInfo currentRinging() {
        return ringing;
    }

    // ----------------------------------------------------------------- channels

    public static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        Uri ringtone = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE);
        if (ringtone == null) ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        NotificationChannel ring = new NotificationChannel(CHANNEL_RING, ctx.getString(R.string.call_channel_ring), NotificationManager.IMPORTANCE_HIGH);
        ring.setDescription(ctx.getString(R.string.call_channel_ring_desc));
        ring.setSound(ringtone, new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        ring.enableVibration(true);
        ring.setVibrationPattern(new long[] {0, 1000, 800, 1000, 800});
        ring.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ring.setBypassDnd(false);
        nm.createNotificationChannel(ring);

        NotificationChannel missed = new NotificationChannel(CHANNEL_MISSED, ctx.getString(R.string.call_channel_missed), NotificationManager.IMPORTANCE_HIGH);
        missed.enableVibration(true);
        nm.createNotificationChannel(missed);

        NotificationChannel ongoing = new NotificationChannel(CHANNEL_ONGOING, ctx.getString(R.string.call_channel_ongoing), NotificationManager.IMPORTANCE_LOW);
        ongoing.setSound(null, null);
        nm.createNotificationChannel(ongoing);
    }

    public static boolean canUseFullScreenIntent(Context ctx) {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        return nm != null && nm.canUseFullScreenIntent();
    }

    public static boolean notificationsAllowed(Context ctx) {
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled();
    }

    // ----------------------------------------------------------------- FCM entry point

    /** Returns true when the message was a call message handled here. */
    public static boolean onPush(Context ctx, Map<String, String> data) {
        String type = data.get("type");
        if (type == null || !type.startsWith("call_")) return false;
        CallInfo info = CallInfo.fromData(data);
        if (info.callId.isEmpty()) return true;
        switch (type) {
            case "call_ring":
                onRing(ctx, info);
                return true;
            case "call_cancel":
                finish(ctx, info.callId, "cancelled");
                return true;
            case "call_missed":
                finish(ctx, info.callId, "missed");
                showMissed(ctx, info);
                return true;
            default:
                return true;
        }
    }

    private static synchronized boolean isFinished(String callId) {
        return FINISHED.containsKey(callId);
    }

    private static synchronized void markFinished(String callId) {
        FINISHED.put(callId, System.currentTimeMillis());
    }

    private static void onRing(Context ctx, CallInfo info) {
        if (info.expired() || isFinished(info.callId)) return;
        CallInfo current = ringing;
        if (current != null && current.callId.equals(info.callId)) {
            // Backup push for the same call: it is already ringing; only confirm again.
            sendRingAck(ctx, info);
            return;
        }
        if (current != null && !current.expired()) {
            // Already ringing for another call: let the server handle the second caller as missed.
            Log.i(TAG, "second call while ringing: " + info.callId);
            return;
        }
        ringing = info;
        ensureChannels(ctx);
        boolean viaTelecom = TelecomBridge.addIncomingCall(ctx, info);
        if (viaTelecom) {
            // Telecom calls ConnectionService → onShowIncomingCallUi → showIncomingNotification. If a
            // device never does (OEM bugs), ring anyway after a short delay.
            MAIN.postDelayed(() -> {
                CallInfo still = ringing;
                if (still != null && still.callId.equals(info.callId) && !TelecomBridge.uiShown(info.callId)) {
                    showIncomingNotification(ctx, info);
                }
            }, 1500);
        } else {
            showIncomingNotification(ctx, info);
        }
        // Stop ringing locally at the end of the ring window even if the cancel push is lost.
        MAIN.postDelayed(() -> {
            CallInfo still = ringing;
            if (still != null && still.callId.equals(info.callId)) finish(ctx, info.callId, "timeout");
        }, info.remainingMs() + 1000);
        sendRingAck(ctx, info);
    }

    // ----------------------------------------------------------------- notifications

    static PendingIntent activityIntent(Context ctx, Class<?> cls, String action, CallInfo info, int requestCode) {
        Intent intent = new Intent(ctx, cls)
            .setAction(action)
            .putExtra(EXTRA_CALL, info.toBundle())
            .putExtra(EXTRA_CALL_ID, info.callId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(ctx, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static PendingIntent broadcastIntent(Context ctx, String action, CallInfo info, int requestCode) {
        Intent intent = new Intent(ctx, CallActionReceiver.class)
            .setAction(action)
            .putExtra(EXTRA_CALL, info.toBundle())
            .putExtra(EXTRA_CALL_ID, info.callId);
        return PendingIntent.getBroadcast(ctx, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** The ringing notification: full-screen over the lock screen, heads-up otherwise, looping ringtone. */
    public static void showIncomingNotification(Context ctx, CallInfo info) {
        if (info.expired() || isFinished(info.callId)) return;
        ensureChannels(ctx);
        int id = info.notificationId();
        PendingIntent fullScreen = activityIntent(ctx, IncomingCallActivity.class, ACTION_SHOW, info, id);
        PendingIntent answer = activityIntent(ctx, MainActivity.class, ACTION_ANSWER, info, id + 1);
        PendingIntent decline = broadcastIntent(ctx, ACTION_DECLINE, info, id + 2);

        Person caller = new Person.Builder().setName(info.callerName).setImportant(true).build();
        String label = info.isVideo() ? "Incoming video call" : "Incoming voice call";
        String detail = info.subtitle();
        String location = info.locationLabel();
        StringBuilder text = new StringBuilder(label);
        if (!detail.isEmpty()) text.append(" · ").append(detail);
        if (!location.isEmpty()) text.append(" · ").append(location);

        Uri ringtone = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE);
        if (ringtone == null) ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_RING)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(info.callerName)
            .setContentText(text.toString())
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(false)
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true)
            .setTimeoutAfter(Math.max(1000L, info.remainingMs()))
            .setSound(ringtone, android.media.AudioManager.STREAM_RING)
            .setVibrate(new long[] {0, 1000, 800, 1000, 800})
            .addPerson(caller)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer).setIsVideo(info.isVideo()));
        Notification notification = builder.build();
        // Loop the ringtone and vibration until the notification is cancelled, like a phone call.
        notification.flags |= Notification.FLAG_INSISTENT | Notification.FLAG_NO_CLEAR;
        notify(ctx, id, notification);
    }

    private static void showMissed(Context ctx, CallInfo info) {
        ensureChannels(ctx);
        Intent open = new Intent(ctx, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(EXTRA_CALL_ACTION, "missed")
            .putExtra(EXTRA_CALL_ID, info.callId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(ctx, info.notificationId() + 3, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String detail = info.subtitle();
        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_MISSED)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(info.isVideo() ? "Missed video call" : "Missed voice call")
            .setContentText("Missed call from " + info.callerName + (detail.isEmpty() ? "" : " (" + detail + ")"))
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(content)
            .setWhen(System.currentTimeMillis())
            .build();
        notify(ctx, info.notificationId() + 7, n);
    }

    private static void notify(Context ctx, int id, Notification n) {
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "notification permission missing; the call cannot ring while the app is closed");
            return;
        }
        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_TAG, id, n);
        } catch (SecurityException e) {
            Log.w(TAG, "notify failed", e);
        }
    }

    // ----------------------------------------------------------------- user actions

    /** Stop ringing on this phone (answered elsewhere, cancelled, missed, ended in the app). */
    public static void finish(Context ctx, String callId, String reason) {
        if (callId == null || callId.isEmpty()) return;
        markFinished(callId);
        CallInfo current = ringing;
        if (current != null && current.callId.equals(callId)) ringing = null;
        NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_TAG, 0x0CA1 ^ callId.hashCode());
        TelecomBridge.endCall(callId, reason);
        ctx.sendBroadcast(new Intent(ACTION_CLOSE_UI).setPackage(ctx.getPackageName()).putExtra(EXTRA_CALL_ID, callId));
    }

    /** Answer: stop the ring and open the app, which joins the WebRTC call (CallBridge 'callAction'). */
    public static void answer(Context ctx, CallInfo info) {
        answer(ctx, info, true);
    }

    /** launch=false when the app is already being opened by the notification's Answer button. */
    public static void answer(Context ctx, CallInfo info, boolean launch) {
        // A backup ring push that arrives after answering must not ring again.
        markFinished(info.callId);
        CallInfo current = ringing;
        if (current != null && current.callId.equals(info.callId)) ringing = null;
        NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_TAG, info.notificationId());
        TelecomBridge.markAnswering(info.callId);
        CallBridgePlugin.queueAction(ctx, "answer", info.callId);
        ctx.sendBroadcast(new Intent(ACTION_CLOSE_UI).setPackage(ctx.getPackageName()).putExtra(EXTRA_CALL_ID, info.callId));
        if (!launch) return;
        Intent open = new Intent(ctx, MainActivity.class)
            .setAction(ACTION_ANSWER)
            .putExtra(EXTRA_CALL_ACTION, "answer")
            .putExtra(EXTRA_CALL_ID, info.callId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        ctx.startActivity(open);
    }

    /** Decline from the lock screen / notification: works without the web app or a session (HMAC token). */
    public static void decline(Context ctx, CallInfo info, Runnable done) {
        finish(ctx, info.callId, "declined");
        CallBridgePlugin.queueAction(ctx, "declined", info.callId);
        IO.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("callId", info.callId);
                body.put("token", info.actionToken);
                body.put("action", "decline");
                post(ctx, "/api/calls/push-action", body);
            } catch (Exception e) {
                Log.w(TAG, "decline failed", e);
            } finally {
                if (done != null) done.run();
            }
        });
    }

    /** Delivery receipt: the caller's screen switches from "Calling…" to "Ringing…". */
    private static void sendRingAck(Context ctx, CallInfo info) {
        IO.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("callId", info.callId);
                body.put("token", info.actionToken);
                body.put("device", (Build.MANUFACTURER + " " + Build.MODEL).trim());
                String fcm = prefs(ctx).getString("fcmToken", null);
                if (fcm != null) body.put("fcmToken", fcm);
                JSONObject res = post(ctx, "/api/calls/ring-ack", body);
                // The call ended while this phone was waking up: never ring for a dead call.
                if (res != null && res.has("ringing") && !res.optBoolean("ringing", true)) {
                    MAIN.post(() -> finish(ctx, info.callId, "ended"));
                }
            } catch (Exception e) {
                Log.w(TAG, "ring ack failed", e);
            }
        });
    }

    private static JSONObject post(Context ctx, String path, JSONObject body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(apiOrigin(ctx) + path).openConnection();
        try {
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Origin", "https://localhost");
            conn.setRequestProperty("X-Client", "bsc-android-calls");
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, path + " -> HTTP " + code);
                return null;
            }
            // InputStream.readAllBytes() needs Android 13; minSdk is 24.
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            try (java.io.InputStream in = conn.getInputStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0 && out.size() < 64 * 1024) out.write(buf, 0, n);
            }
            return new JSONObject(out.toString("UTF-8"));
        } finally {
            conn.disconnect();
        }
    }
}
