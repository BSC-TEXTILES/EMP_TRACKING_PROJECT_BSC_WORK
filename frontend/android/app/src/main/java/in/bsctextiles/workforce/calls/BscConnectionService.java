package in.bsctextiles.workforce.calls;

import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.telecom.Connection;
import android.telecom.ConnectionRequest;
import android.telecom.ConnectionService;
import android.telecom.DisconnectCause;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import androidx.annotation.RequiresApi;

/** Self-managed ConnectionService: one Telecom Connection per incoming BSC call (see TelecomBridge). */
@RequiresApi(api = Build.VERSION_CODES.O)
public class BscConnectionService extends ConnectionService {

    @Override
    public Connection onCreateIncomingConnection(PhoneAccountHandle account, ConnectionRequest request) {
        Bundle extras = request.getExtras();
        Bundle infoBundle = extras == null ? null : extras.getBundle(TelecomBridge.EXTRA_INFO);
        CallInfo info = CallInfo.fromBundle(infoBundle);
        if (info == null) return Connection.createFailedConnection(new DisconnectCause(DisconnectCause.ERROR));
        BscConnection connection = new BscConnection(getApplicationContext(), info);
        connection.setConnectionProperties(Connection.PROPERTY_SELF_MANAGED);
        connection.setAudioModeIsVoip(true);
        connection.setAddress(request.getAddress(), TelecomManager.PRESENTATION_ALLOWED);
        connection.setCallerDisplayName(info.callerName, TelecomManager.PRESENTATION_ALLOWED);
        connection.setRinging();
        TelecomBridge.onConnectionCreated(info.callId, connection);
        return connection;
    }

    @Override
    public void onCreateIncomingConnectionFailed(PhoneAccountHandle account, ConnectionRequest request) {
        // Telecom refused (e.g. an emergency call is in progress): ring with the notification alone.
        Bundle extras = request.getExtras();
        CallInfo info = CallInfo.fromBundle(extras == null ? null : extras.getBundle(TelecomBridge.EXTRA_INFO));
        if (info != null) CallManager.showIncomingNotification(getApplicationContext(), info);
    }

    public static final class BscConnection extends Connection {
        private final Context ctx;
        private final CallInfo info;
        private boolean finished;

        BscConnection(Context ctx, CallInfo info) {
            this.ctx = ctx;
            this.info = info;
        }

        @Override
        public void onShowIncomingCallUi() {
            TelecomBridge.onUiShown(info.callId);
            CallManager.showIncomingNotification(ctx, info);
        }

        /** Answer from a Bluetooth headset, car or wearable. */
        @Override
        public void onAnswer() {
            CallManager.answer(ctx, info);
        }

        @Override
        public void onAnswer(int videoState) {
            onAnswer();
        }

        @Override
        public void onReject() {
            CallManager.decline(ctx, info, null);
        }

        /** Hang-up from a headset / car while connected. */
        @Override
        public void onDisconnect() {
            if (getState() == STATE_ACTIVE) {
                CallBridgePlugin.queueAction(ctx, "hangup", info.callId);
            } else {
                CallManager.decline(ctx, info, null);
            }
            finish(new DisconnectCause(DisconnectCause.LOCAL));
        }

        @Override
        public void onAbort() {
            finish(new DisconnectCause(DisconnectCause.CANCELED));
        }

        void finish(DisconnectCause cause) {
            if (finished) return;
            finished = true;
            TelecomBridge.forget(info.callId);
            setDisconnected(cause);
            destroy();
        }
    }
}
