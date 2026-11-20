package in.bsctextiles.workforce.calls;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Notification buttons that must work without opening the app: Decline (ringing) and Hang up (ongoing call). */
public class CallActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (CallManager.ACTION_DECLINE.equals(action)) {
            CallInfo info = CallInfo.fromBundle(intent.getBundleExtra(CallManager.EXTRA_CALL));
            if (info == null) return;
            PendingResult pending = goAsync();
            CallManager.decline(context.getApplicationContext(), info, pending::finish);
        } else if (CallManager.ACTION_HANGUP.equals(action)) {
            String callId = intent.getStringExtra(CallManager.EXTRA_CALL_ID);
            // The web app ends the WebRTC call and tells the server; the ongoing notification goes away with it.
            CallBridgePlugin.queueAction(context, "hangup", callId);
            OngoingCallService.stop(context);
        }
    }
}
