# Role-based access control

## 1. Model

```
employee → role → role_permissions → permissions
employee → user_permissions (grant | deny)  // per-user override, takes precedence
```

Effective permissions = role permissions, plus explicit grants, minus explicit denies. The API recomputes this on every authenticated request; the UI gates navigation with the same list, but the server is always authoritative.

## 2. Roles seeded

| Role | Slug | Level | Permissions | Intended scope |
|---|---|---:|---:|---|
| Super Admin | `super_admin` | 100 | 59 | Everything, including settings, roles, audit |
| Company Owner | `company_owner` | 95 | 59 | Same as Super Admin (ownership) |
| Executive Leadership | `executive` | 90 | 51 | Company-wide read/analytics, KPI publish, no role editing |
| General Manager | `general_manager` | 80 | 37 | Multi-department operations, approvals |
| Department Head | `department_head` | 70 | 34 | Department subtree, KPI review, reports |
| HR Manager | `hr_manager` | 65 | 47 | All employees, registrations, leave HR stage, attendance corrections |
| Manager | `manager` | 60 | 32 | Reporting subtree: tasks, reports, attendance view |
| IT Administrator | `it_admin` | 55 | 38 | Users, roles (if granted), IT tickets, system views |
| Store Manager | `store_manager` | 50 | 34 | Store/location staff within reporting tree |
| Payroll Administrator | `payroll_admin` | 45 | 18 | Attendance/payroll data, exports |
| HR Executive | `hr_executive` | 40 | 19 | Employee records support, leave processing |
| IT Helpdesk Executive | `helpdesk` | 30 | 16 | Ticket queue, resolution |
| Employee | `employee` | 10 | 13 | Own attendance, tasks, reports, chat, tickets, leave, KPI |

Super Admin can create additional roles and designations, and edit the permission matrix at **Roles & Access**.

## 3. Permission catalogue (59 codes)

| Module | Codes |
|---|---|
| Admin | `admin.dashboard` |
| Analytics | `analytics.view`, `analytics.view.all` |
| Attendance | `attendance.view.own`, `attendance.view.team`, `attendance.view.all`, `attendance.manage`, `attendance.corrections.approve` |
| Audit | `audit.view` |
| Chat | `chat.use`, `chat.groups.manage`, `chat.moderate` |
| Dashboard | `dashboard.view` |
| Employees | `employees.view.own`, `employees.view.team`, `employees.view.all`, `employees.manage`, `employees.approve` |
| Exports | `reports.export` |
| KPI | `kpi.view.own`, `kpi.view.team`, `kpi.view.all`, `kpi.review`, `kpi.configure`, `kpi.publish` |
| Leave | `leave.view.own`, `leave.view.team`, `leave.view.all`, `leave.apply`, `leave.approve.manager`, `leave.approve.hr`, `leave.manage` |
| Meetings | `meetings.create`, `meetings.manage` |
| Notifications | `notifications.send` |
| Organisation | `org.manage` |
| Projects | `projects.view`, `projects.create`, `projects.manage` |
| Reports | `reports.view.own`, `reports.view.team`, `reports.view.all`, `reports.review` |
| Roles | `roles.manage` |
| Settings | `settings.manage` |
| Tasks | `tasks.view.own`, `tasks.view.team`, `tasks.view.all`, `tasks.create`, `tasks.assign`, `tasks.approve`, `tasks.delete` |
| Tickets | `tickets.view.own`, `tickets.view.team`, `tickets.view.all`, `tickets.create`, `tickets.assign`, `tickets.resolve`, `tickets.manage` |

## 4. Scope resolution (server)

Every scoped query follows the same pattern:

```
if permission.includes('<module>.view.all')  → no filter
else if permission.includes('<module>.view.team') → employee_id IN recursive subtree(me)
else → employee_id = me
```

- Subtree uses a recursive CTE over `employees.manager_id`, inclusive of the manager.
- Detail endpoints repeat the same clause, so a guessed ID returns 404/403 rather than data.
- Task allocation and reassignment additionally call `assertCanAllocateTo`, which forbids targeting anyone outside the subtree unless `tasks.view.all` is held.
- Chat access requires actual `conversation_members` rows; being an admin does not grant reading arbitrary conversations.
- Meeting access requires an invitation or `meetings.manage`.
- Files inherit the visibility of the record they were uploaded for; `GET /files/:id` checks ownership/attachment access.

## 5. Module access matrix (defaults)

| Module | Employee | Manager | Dept Head | HR Manager | IT Admin | Executive | Super Admin |
|---|---|---|---|---|---|---|---|
| Dashboard (own) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Attendance own | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Attendance team | — | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Attendance all / corrections approve | — | — | ✅ | ✅ | — | ✅ | ✅ |
| Tasks own / accept / submit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tasks create + assign (subtree) | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tasks approve | — | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Daily report own | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reports review (team/all) | — | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Chat | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Group management | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tickets own / create | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ticket assign / resolve | — | — | ✅ | — | ✅ | ✅ | ✅ |
| Meetings schedule | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| KPI own | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| KPI team review | — | — | ✅ | ✅ | — | ✅ | ✅ |
| KPI configure / publish | — | — | — | — | — | ✅ | ✅ |
| Leave apply | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Leave manager approval | — | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Leave HR approval | — | — | — | ✅ | — | ✅ | ✅ |
| Employees (own) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Employees (team/all) | — | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Employee management / approval | — | — | — | ✅ | — | — | ✅ |
| Organisation structure | read | read | read | manage | read | read | manage |
| Analytics | — | team | team | all | — | all | all |
| Roles & permissions | — | — | — | — | manage* | — | ✅ |
| Settings & audit | — | — | audit | audit | system | audit | ✅ |
| Announcements | — | — | ✅ | ✅ | ✅ | ✅ | ✅ |

\* `it_admin` holds `roles.manage` in the seed; remove it if IT should not control access.

## 6. Hierarchy rules enforced

1. An employee has at most one `manager_id`; changes that create a cycle are rejected.
2. Managers allocate only inside their subtree (task creation, reassignment, project membership checks).
3. Managers see only subtree members in employee lists, attendance team view, report review, KPI team view and leave approval.
4. HR with `employees.view.all` sees the organisation but still needs `roles.manage` for permissions.
5. Store managers are constrained by location when `location_id` scoping is configured; the default seed grants subtree scope.
6. Super Admin bypasses scope but every action is still audited.

## 7. Changing access safely

1. Open **Roles & Access**, pick the role, toggle permissions, save. The server records before/after in `audit_logs`.
2. Per-user exceptions: `POST /employees/:id/permissions {permissionId, effect: grant|deny|clear}`.
3. Existing sessions pick up changes on the next request; no re-login is required.
4. Review `audit_logs` for `role.permissions_updated` after changes.
