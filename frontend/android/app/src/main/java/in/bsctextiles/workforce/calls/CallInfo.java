package in.bsctextiles.workforce.calls;

import android.os.Bundle;
import java.util.Map;

/** An incoming call as described by the server's data-only FCM push (PushService.sendCall). */
public final class CallInfo {
    public final String callId;
    public final String callType;
    public final String callerId;
    public final String callerName;
    public final String callerCode;
    public final String callerDesignation;
    public final String callerLocationCode;
    public final String callerLocationName;
    public final String callerPhoto;
    public final long expiresAt;
    public final String actionToken;

    private CallInfo(Bundle b) {
        callId = str(b.getString("callId"));
        callType = "video".equals(b.getString("callType")) ? "video" : "audio";
        callerId = str(b.getString("callerId"));
        callerName = b.getString("callerName") == null || b.getString("callerName").isEmpty() ? "A colleague" : b.getString("callerName");
        callerCode = str(b.getString("callerCode"));
        callerDesignation = str(b.getString("callerDesignation"));
        callerLocationCode = str(b.getString("callerLocationCode"));
        callerLocationName = str(b.getString("callerLocationName"));
        callerPhoto = str(b.getString("callerPhoto"));
        expiresAt = b.getLong("expiresAt", System.currentTimeMillis() + 30_000L);
        actionToken = str(b.getString("actionToken"));
    }

    private static String str(String v) {
        return v == null ? "" : v;
    }

    public static CallInfo fromData(Map<String, String> data) {
        Bundle b = new Bundle();
        for (String key : new String[] {"callId", "callType", "callerId", "callerName", "callerCode", "callerDesignation",
            "callerLocationCode", "callerLocationName", "callerPhoto", "actionToken"}) {
            b.putString(key, data.get(key));
        }
        long expires;
        try {
            expires = Long.parseLong(data.get("expiresAt"));
        } catch (Exception e) {
            expires = System.currentTimeMillis() + 30_000L;
        }
        b.putLong("expiresAt", expires);
        return new CallInfo(b);
    }

    public static CallInfo fromBundle(Bundle b) {
        return b == null ? null : new CallInfo(b);
    }

    public Bundle toBundle() {
        Bundle b = new Bundle();
        b.putString("callId", callId);
        b.putString("callType", callType);
        b.putString("callerId", callerId);
        b.putString("callerName", callerName);
        b.putString("callerCode", callerCode);
        b.putString("callerDesignation", callerDesignation);
        b.putString("callerLocationCode", callerLocationCode);
        b.putString("callerLocationName", callerLocationName);
        b.putString("callerPhoto", callerPhoto);
        b.putLong("expiresAt", expiresAt);
        b.putString("actionToken", actionToken);
        return b;
    }

    public boolean isVideo() {
        return "video".equals(callType);
    }

    public boolean expired() {
        return System.currentTimeMillis() >= expiresAt;
    }

    public long remainingMs() {
        return Math.max(0L, expiresAt - System.currentTimeMillis());
    }

    /** "EMP-1001 · Store Manager" */
    public String subtitle() {
        StringBuilder sb = new StringBuilder();
        if (!callerCode.isEmpty()) sb.append(callerCode);
        if (!callerDesignation.isEmpty()) {
            if (sb.length() > 0) sb.append(" · ");
            sb.append(callerDesignation);
        }
        return sb.toString();
    }

    /** "BEL · Belagavi" */
    public String locationLabel() {
        if (callerLocationCode.isEmpty()) return callerLocationName;
        if (callerLocationName.isEmpty() || callerLocationName.equalsIgnoreCase(callerLocationCode)) return callerLocationCode;
        return callerLocationCode + " · " + callerLocationName;
    }

    public int notificationId() {
        return 0x0CA1 ^ callId.hashCode();
    }
}
