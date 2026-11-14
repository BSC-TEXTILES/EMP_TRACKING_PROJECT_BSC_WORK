# Security architecture
This increment adds rotating refresh tokens, strict cookies, production JWT-secret validation, fail-closed antivirus upload validation, private file access, safer IP extraction and limited public health output. Proxy trust defaults off; loopback trust is explicit. Ticket file ownership is validated inside creation transactions.

Production acceptance is blocked by the gaps in ENTERPRISE_ACCEPTANCE.md. Dependencies were upgraded and compatibility checks passed; npm audit now reports zero known vulnerabilities. Existing root-level development response/cookie files may contain sensitive local session data and must not be published. They were not read as part of this implementation and were not deleted.

Complete platform-wide authorization, log redaction, distributed abuse detection, WebSocket revocation and an independent security assessment remain required.
