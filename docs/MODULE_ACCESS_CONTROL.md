# Module access control
Existing role permissions and individual grant/deny overrides are resolved by AuthService and enforced in API middleware. Ticket routes require module permissions and ticket actions additionally check record scope. Removing ticket-resolution permission now prevents an assignee from continuing technician actions.

Not yet complete: department/location/designation grants, expiry, permission approvals, complete action-level audit across all routes, and immediate reauthorization of established WebSocket subscriptions. Frontend navigation is not an authorization boundary. Do not represent the current implementation as meeting the complete permissions specification.
