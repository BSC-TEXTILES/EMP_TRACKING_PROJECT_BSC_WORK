# JWT session management
Access JWTs expire in 900 seconds and are stored in HttpOnly cookies. Refresh tokens are random 48-byte values, stored in an HttpOnly SameSite=Strict cookie restricted to /api/auth. Production cookies require HTTPS. Only SHA-256 refresh-token hashes are stored. Every refresh consumes the prior token in a database transaction and locks the session row. Reusing a consumed token commits family revocation before returning 401.

Refresh never changes employee_sessions.expires_at. SESSION_TTL_DAYS is the absolute cap, including remembered logins. Password changes revoke sessions. Logout revokes the session through the refresh token even when the access token has expired. Existing device/session management remains available.

The API client schedules renewal one minute before the reported expiry, shares a refresh promise, and uses Web Locks for cross-tab serialization. Only non-secret expiry metadata is stored in localStorage. Failed renewal stops protected client requests, clears auth state and shows a session-expired message on login. A transient refresh failure requires sign-in again. Browsers without Web Locks lack cross-tab serialization.

Migration 005 creates refresh history. Migration 006 revokes pre-upgrade sessions. Consumed token hashes must remain until the associated session expires for reuse detection. A retention job is still required. Existing WebSocket connections need additional session-revocation enforcement before production acceptance.
