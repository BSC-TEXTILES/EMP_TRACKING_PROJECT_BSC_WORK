package in.bsctextiles.workforce.calls;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import in.bsctextiles.workforce.MainActivity;
import in.bsctextiles.workforce.R;

/**
 * Foreground service for a connected call. Android blocks microphone access for apps in the
 * background; while this service runs the call keeps its audio when the user locks the phone or
 * switches to another app. It shows the ongoing-call notification with a timer and Hang up.
 */
public class OngoingCallService extends Service {
    private static final int NOTIFICATION_ID = 0x0CA11;

    public static void start(Context ctx, String callId, String peerName, long startedAt, boolean video) {
        Intent i = new Intent(ctx, OngoingCallService.class)
            .putExtra(CallManager.EXTRA_CALL_ID, callId)
            .putExtra("peerName", peerName)
            .putExtra("startedAt", startedAt)
            .putExtra("video", video);
        try {
            ContextCompat.startForegroundService(ctx, i);
        } catch (Exception e) {
            // Not allowed from the background on Android 12+: the call still works while the app is open.
            Log.w("BscCalls", "ongoing call service not started", e);
        }
    }

    public static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, OngoingCallService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        CallManager.ensureChannels(this);
        String callId = intent.getStringExtra(CallManager.EXTRA_CALL_ID);
        String peer = intent.getStringExtra("peerName");
        long startedAt = intent.getLongExtra("startedAt", System.currentTimeMillis());
        Person person = new Person.Builder().setName(peer == null || peer.isEmpty() ? "Colleague" : peer).setImportant(true).build();

        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 11, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent hangupIntent = new Intent(this, CallActionReceiver.class).setAction(CallManager.ACTION_HANGUP).putExtra(CallManager.EXTRA_CALL_ID, callId);
        PendingIntent hangup = PendingIntent.getBroadcast(this, 12, hangupIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new NotificationCompat.Builder(this, CallManager.CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(person.getName())
            .setContentText("BSC Workforce call in progress")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setWhen(startedAt)
            .setContentIntent(content)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangup).setIsVideo(intent.getBooleanExtra("video", false)))
            .build();
        int type = 0;
        if (Build.VERSION.SDK_INT >= 30) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type);
        } catch (Exception e) {
            Log.w("BscCalls", "startForeground failed", e);
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App swiped away mid-call: the WebRTC call is gone, do not leave a stale "in call" notification.
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
