package in.bsctextiles.workforce;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import in.bsctextiles.workforce.calls.CallBridgePlugin;
import in.bsctextiles.workforce.calls.CallManager;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Native call layer (lock-screen ringing, Telecom, audio routing) exposed to the web app.
        registerPlugin(CallBridgePlugin.class);
        super.onCreate(savedInstanceState);
        CallManager.ensureChannels(this);
        CallBridgePlugin.handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // "Answer" from the ringing notification / lock-screen call screen while the app is running.
        CallBridgePlugin.handleIntent(intent);
    }
}
