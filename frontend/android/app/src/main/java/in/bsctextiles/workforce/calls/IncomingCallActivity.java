package in.bsctextiles.workforce.calls;

import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import in.bsctextiles.workforce.R;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Native full-screen incoming call, shown over the lock screen by the ringing notification's
 * full-screen intent (or when the user taps the heads-up notification). The ringtone and vibration
 * come from the notification itself (FLAG_INSISTENT), so they keep going if this screen is closed.
 */
public class IncomingCallActivity extends AppCompatActivity {
    private CallInfo info;
    private TextView status;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean handled;

    private final BroadcastReceiver closeReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String id = intent.getStringExtra(CallManager.EXTRA_CALL_ID);
            if (info != null && info.callId.equals(id)) finishAndRemoveTask();
        }
    };

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showOverLockScreen();
        info = CallInfo.fromBundle(getIntent().getBundleExtra(CallManager.EXTRA_CALL));
        if (info == null || info.expired()) {
            finishAndRemoveTask();
            return;
        }
        setContentView(buildUi());
        IntentFilter filter = new IntentFilter(CallManager.ACTION_CLOSE_UI);
        ContextCompat.registerReceiver(this, closeReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        // Close at the end of the ring window; the server turns the call into a missed call.
        handler.postDelayed(() -> {
            if (!handled) {
                status.setText("Missed call");
                handler.postDelayed(this::finishAndRemoveTask, 1500);
            }
        }, info.remainingMs());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        CallInfo next = CallInfo.fromBundle(intent.getBundleExtra(CallManager.EXTRA_CALL));
        if (next != null && !next.callId.equals(info != null ? info.callId : null)) {
            setIntent(intent);
            recreate();
        }
    }

    private void showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private static String initials(String name) {
        String[] parts = name.trim().split("\\s+");
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (!p.isEmpty() && sb.length() < 2) sb.append(Character.toUpperCase(p.charAt(0)));
        }
        return sb.length() == 0 ? "?" : sb.toString();
    }

    private View buildUi() {
        FrameLayout root = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] {Color.parseColor("#1D4ED8"), Color.parseColor("#0B2A6F"), Color.parseColor("#0A1630")});
        root.setBackground(bg);

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        column.setPadding(dp(24), dp(56), dp(24), dp(40));
        root.addView(column, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        TextView brand = text("BSC WORKFORCE", 12, Color.argb(170, 255, 255, 255), true);
        brand.setLetterSpacing(0.2f);
        column.addView(brand);

        TextView kind = text(info.isVideo() ? "Incoming video call" : "Incoming voice call", 16, Color.argb(220, 255, 255, 255), false);
        kind.setPadding(0, dp(6), 0, 0);
        column.addView(kind);

        // Avatar with animated rings.
        FrameLayout avatarBox = new FrameLayout(this);
        LinearLayout.LayoutParams boxLp = new LinearLayout.LayoutParams(dp(220), dp(220));
        boxLp.topMargin = dp(36);
        column.addView(avatarBox, boxLp);
        for (int i = 0; i < 2; i++) {
            View ring = new View(this);
            GradientDrawable ringShape = new GradientDrawable();
            ringShape.setShape(GradientDrawable.OVAL);
            ringShape.setColor(Color.argb(60, 255, 255, 255));
            ring.setBackground(ringShape);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(140), dp(140), Gravity.CENTER);
            avatarBox.addView(ring, lp);
            pulse(ring, i * 700L);
        }
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(Color.parseColor("#3B82F6"));
        circle.setStroke(dp(4), Color.argb(90, 255, 255, 255));
        TextView initialsView = text(initials(info.callerName), 44, Color.WHITE, true);
        initialsView.setGravity(Gravity.CENTER);
        initialsView.setBackground(circle);
        avatarBox.addView(initialsView, new FrameLayout.LayoutParams(dp(140), dp(140), Gravity.CENTER));
        ImageView photo = new ImageView(this);
        photo.setScaleType(ImageView.ScaleType.CENTER_CROP);
        photo.setVisibility(View.GONE);
        photo.setClipToOutline(true);
        GradientDrawable photoShape = new GradientDrawable();
        photoShape.setShape(GradientDrawable.OVAL);
        photo.setBackground(photoShape);
        avatarBox.addView(photo, new FrameLayout.LayoutParams(dp(140), dp(140), Gravity.CENTER));
        loadPhoto(photo);

        TextView name = text(info.callerName, 30, Color.WHITE, true);
        name.setPadding(0, dp(8), 0, 0);
        name.setMaxLines(2);
        column.addView(name);
        String subtitle = info.subtitle();
        if (!subtitle.isEmpty()) {
            TextView sub = text(subtitle, 15, Color.argb(210, 255, 255, 255), false);
            sub.setPadding(0, dp(6), 0, 0);
            column.addView(sub);
        }
        String location = info.locationLabel();
        if (!location.isEmpty()) {
            TextView chip = text("📍 " + location, 13, Color.WHITE, true);
            GradientDrawable chipBg = new GradientDrawable();
            chipBg.setCornerRadius(dp(14));
            chipBg.setColor(Color.argb(50, 255, 255, 255));
            chip.setBackground(chipBg);
            chip.setPadding(dp(12), dp(5), dp(12), dp(5));
            LinearLayout.LayoutParams chipLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            chipLp.topMargin = dp(12);
            column.addView(chip, chipLp);
        }
        status = text("Ringing…", 14, Color.argb(190, 255, 255, 255), false);
        status.setPadding(0, dp(18), 0, 0);
        column.addView(status);
        ObjectAnimator blink = ObjectAnimator.ofFloat(status, View.ALPHA, 1f, 0.35f);
        blink.setDuration(900);
        blink.setRepeatMode(ValueAnimator.REVERSE);
        blink.setRepeatCount(ValueAnimator.INFINITE);
        blink.start();

        View spacer = new View(this);
        column.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1f));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        column.addView(buttons, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        buttons.addView(actionButton("Decline", Color.parseColor("#EF4444"), R.drawable.ic_call_decline, v -> onDecline()), weight());
        buttons.addView(actionButton("Answer", Color.parseColor("#10B981"), R.drawable.ic_call_answer, v -> onAnswer()), weight());
        return root;
    }

    private LinearLayout.LayoutParams weight() {
        return new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
    }

    private View actionButton(String label, int color, int icon, View.OnClickListener onClick) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        ImageButton button = new ImageButton(this);
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.OVAL);
        shape.setColor(color);
        button.setBackground(shape);
        button.setImageResource(icon);
        button.setContentDescription(label + " call");
        button.setElevation(dp(8));
        button.setOnClickListener(onClick);
        box.addView(button, new LinearLayout.LayoutParams(dp(76), dp(76)));
        TextView caption = text(label, 14, Color.WHITE, true);
        caption.setPadding(0, dp(10), 0, 0);
        box.addView(caption);
        return box;
    }

    private TextView text(String value, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(value);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return t;
    }

    private void pulse(View ring, long delay) {
        ObjectAnimator sx = ObjectAnimator.ofFloat(ring, View.SCALE_X, 1f, 1.55f);
        ObjectAnimator sy = ObjectAnimator.ofFloat(ring, View.SCALE_Y, 1f, 1.55f);
        ObjectAnimator a = ObjectAnimator.ofFloat(ring, View.ALPHA, 0.9f, 0f);
        for (ObjectAnimator o : new ObjectAnimator[] {sx, sy, a}) {
            o.setRepeatCount(ValueAnimator.INFINITE);
            o.setDuration(1400);
        }
        AnimatorSet set = new AnimatorSet();
        set.playTogether(sx, sy, a);
        set.setStartDelay(delay);
        set.start();
    }

    /** Best effort: public profile photos only. Initials are shown otherwise. */
    private void loadPhoto(ImageView target) {
        String url = info.callerPhoto;
        if (url.isEmpty()) return;
        final String full = url.startsWith("https://") ? url : url.startsWith("/") ? CallManager.apiOrigin(this) + url : null;
        if (full == null) return;
        new Thread(() -> {
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(full).openConnection();
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(4000);
                if (conn.getResponseCode() != 200) return;
                try (InputStream in = conn.getInputStream()) {
                    Bitmap bmp = BitmapFactory.decodeStream(in);
                    if (bmp != null) runOnUiThread(() -> {
                        target.setImageBitmap(bmp);
                        target.setVisibility(View.VISIBLE);
                    });
                }
            } catch (Exception ignored) {
                // initials stay visible
            }
        }).start();
    }

    private void onAnswer() {
        if (handled) return;
        handled = true;
        status.setText("Connecting…");
        // Unlock is not required: the call screen of the app is also shown over the lock screen.
        CallManager.answer(getApplicationContext(), info);
        finishAndRemoveTask();
    }

    private void onDecline() {
        if (handled) return;
        handled = true;
        status.setText("Declined");
        CallManager.decline(getApplicationContext(), info, null);
        finishAndRemoveTask();
    }

    @Override
    public void onBackPressed() {
        // Back only hides this screen; the phone keeps ringing until the call is answered or declined.
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        try {
            unregisterReceiver(closeReceiver);
        } catch (Exception ignored) {
            // never registered (expired call)
        }
        super.onDestroy();
    }

    @SuppressWarnings("unused")
    private void requestUnlock() {
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        if (km != null && Build.VERSION.SDK_INT >= 26) km.requestDismissKeyguard(this, null);
    }
}
