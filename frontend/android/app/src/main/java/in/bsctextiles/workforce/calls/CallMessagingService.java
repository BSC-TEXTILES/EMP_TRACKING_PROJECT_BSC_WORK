package in.bsctextiles.workforce.calls;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * The app's single FCM entry point (replaces the Capacitor plugin's service in the manifest).
 * Call messages are handled natively so the phone rings while the app is closed or locked;
 * everything else is forwarded to the Capacitor push plugin unchanged.
 */
public class CallMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        if (CallManager.onPush(getApplicationContext(), remoteMessage.getData())) {
            // Also let an open web app know (it shows its own screen and ignores duplicates).
            CallBridgePlugin.forwardPush(remoteMessage.getData());
            return;
        }
        super.onMessageReceived(remoteMessage);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        CallManager.setFcmToken(getApplicationContext(), token);
        super.onNewToken(token);
    }
}
