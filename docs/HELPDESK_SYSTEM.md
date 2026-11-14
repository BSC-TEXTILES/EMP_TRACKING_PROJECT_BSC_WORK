# Helpdesk system
Tickets persist in MySQL with employee identity snapshots, issue details, priority, SLA, assignment, comments and multiple attachments. The ticket form supplies reproduction steps, results, error details, device context, impact, urgency, occurrence time, related project and remarks. Diagnostics are opt-in and restricted to online status and viewport dimensions; the API rejects diagnostics without consent and rejects unknown diagnostic properties.

Only clean files owned by the submitting employee can be linked to a new ticket. Downloads require record-level access. Office/archive uploads are currently blocked; scanning must be configured for other uploads.

Remaining: configurable multi-criteria routing, technician workspace filters, date-range ticket reports, complete timeline and expanded workflow states. Existing least-loaded assignment is not a complete support-team routing engine.
