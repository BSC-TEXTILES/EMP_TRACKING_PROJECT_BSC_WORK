# Documentation index

| Document | Contents |
|---|---|
| [PRD.md](PRD.md) | Product requirements, personas, user stories, acceptance criteria |
| [SYSTEM.md](SYSTEM.md) | Architecture, module map, API/WebSocket/auth/attendance/task/notification/KPI flows |
| [MEMORY.md](MEMORY.md) | Project context, decisions, conventions, completed and pending work, known issues |
| [DATABASE.md](DATABASE.md) | Schema, relationships, ER diagram, migrations, indexing strategy |
| [API_DOCUMENTATION.md](API_DOCUMENTATION.md) | Every endpoint, payloads, responses, errors |
| [RBAC.md](RBAC.md) | Roles, permission matrix, hierarchy and data scope rules |
| [WORKFLOWS.md](WORKFLOWS.md) | Registration, attendance, tasks, reports, tickets, chat, meetings, KPI, leave |
| [SECURITY.md](SECURITY.md) | Authentication, OTP, rate limits, access control, audit, files, data protection |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production setup, database, SSL, backups, monitoring, rollback |
| [TESTING.md](TESTING.md) | Test strategy, automated suite, manual QA matrix, results |
| [MOBILE_APP.md](MOBILE_APP.md) | PWA architecture, install, offline behaviour, notifications |
| [EMAIL.md](EMAIL.md) | SMTP configuration, templates, queue, retries, admin page |
| [COLLECTIONS.md](COLLECTIONS.md) | Collection register, workflow, permissions, API and exports |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Environment files, variable groups, validation and secret management |
| [JWT_SESSION_MANAGEMENT.md](JWT_SESSION_MANAGEMENT.md) | Access/refresh tokens, rotation, reuse detection, client renewal |
| [DIAGRAMS.md](DIAGRAMS.md) | Architecture, ER, user flow, hierarchy, task, attendance and notification diagrams |

## Reading order

1. **New developer:** README → MEMORY → SYSTEM → DATABASE → RBAC.
2. **Reviewer / stakeholder:** PRD → WORKFLOWS → TESTING.
3. **Operations:** DEPLOYMENT → SECURITY → MOBILE_APP.

## What makes this one system, not a set of modules

- One employee record (`employees`) is the subject of attendance, tasks, reports, tickets, chat membership, meetings, leave, projects and KPI records, joined by foreign keys.
- One permission system governs REST routes, WebSocket events, file access and UI navigation.
- One real-time bus notifies the same users whose records changed, so dashboards, badges and lists update without a refresh.
- One audit table records who changed what, with before/after snapshots, for every sensitive action.
