package in.bsctextiles.workforce.calls;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.util.HashMap;
import java.util.Map;

/**
 * DEBUG BUILDS ONLY (src/debug). Feeds a fake call push into the same code path FCM uses, so the
 * lock-screen ring, Telecom registration and cancel/missed handling can be tested on an emulator:
 *
 *   adb shell am broadcast -a in.bsctextiles.workforce.DEBUG_CALL -p in.bsctextiles.workforce \
 *       --es type call_ring --es callId test1 --es callerName "Gagan C B" --es callerCode EMP-1001 \
 *       --es callerDesignation "Store Manager" --es callerLocationCode BEL --es callerLocationName Belagavi
 *   adb shell am broadcast -a in.bsctextiles.workforce.DEBUG_CALL -p in.bsctextiles.workforce --es type call_cancel --es callId test1
 *
 * Network calls (ring receipt, decline) go to an unroutable origin so no real server is contacted.
 */
public class DebugCallReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Map<String, String> data = new HashMap<>();
        for (String key : new String[] {"type", "callId", "callType", "callerId", "callerName", "callerCode", "callerDesignation",
            "callerLocationCode", "callerLocationName", "callerPhoto", "actionToken"}) {
            String v = intent.getStringExtra(key);
            if (v != null) data.put(key, v);
        }
        long seconds = intent.getIntExtra("seconds", 30);
        data.put("expiresAt", java.lang.String.valueOf(System.currentTimeMillis() + seconds * 1000L));
        if (!data.containsKey("actionToken")) data.put("actionToken", "debug-token-debug-token-debug-token-0000");
        CallManager.setApiOrigin(context, "https://10.255.255.1");
        CallManager.onPush(context.getApplicationContext(), data);
    }
}
