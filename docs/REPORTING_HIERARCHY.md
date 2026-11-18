# Reporting hierarchy, location tracking and analytics

Where: **Organisation → Reporting hierarchy** (`/organization?tab=hierarchy`).
API: `/api/hierarchy/*`. Service: `backend/src/services/HierarchyService.ts`.

## Structure

- **Renukaradhya – Software Manager** (role `software_manager`, designation *Software Manager*,
  IT & Technology) is the root. Every active employee's reporting chain ends at them.
- Existing manager relationships are kept. At startup, and after employees are created, approved or
  reassigned, `ensureStructure()` attaches only the *top* of a broken chain to the root: someone with
  no manager, a manager who left, or one member of a reporting cycle. Everyone below keeps their manager.
- Every employee has a location: BEL (Belagavi), DAV (Davanagere), SHI (Shivamogga), HQ (Head Office).
  Anyone without a location is placed in HQ and the change is written to `audit_logs`
  (`hierarchy.location_defaulted`). Correct it from the profile drawer.
- Every reporting change is kept in `reporting_assignments` (manager, previous manager, reason,
  who, from/to). Migration 030 records everyone's current line as the baseline.

## Who sees what (enforced in the API)

| Viewer | Permission | Sees |
|---|---|---|
| Super Admin | all | Everything; can change managers, locations and location managers |
| Software Manager | `hierarchy.view.all` + `locations.view.all` | All employees and locations, read-only |
| Executive | same | All locations, read-only |
| Location Manager / Store Manager / HR Manager | `hierarchy.view.all` | Their own location plus any location granted to them |
| Manager | `*.view.team` | Their reporting subtree |
| Employee | – | Themselves and the name of their reporting manager |

Asking for another location (`?locationId=`) or another employee (`/employees/:id`) outside the
viewer's scope returns **403**. `/api/employees/hierarchy` is now scoped the same way; before this
change it returned the whole organisation to anyone signed in.

**Making someone a location manager:** give them the *Location Manager* role (Employees → edit),
then, as Super Admin, use **Location managers** on the location card to grant extra locations.

## Screens

- **Root header** – Renukaradhya | Software Manager, with today's totals.
- **Location switcher** – All locations / BEL / DAV / SHI / HQ, with employee and working counts.
- **Reporting tree** – grouped by location; expand/collapse; group by reporting line or by department;
  search by name or employee ID; department filter. Click an employee for the profile drawer.
- **Live tracking** – Working, In a meeting, On break, Inactive (idle), Offline (checked in),
  Online (not checked in), Checked out, On leave and Not logged in. Shows the section in use, login,
  logout, last activity and worked time. Refreshes every 30 seconds.
- **Attendance analytics** – Today / Yesterday / This week / This month / Custom range (up to 93 days):
  present, absent, leave, late, early departures, working now, offline now, total and average hours,
  attendance %, location comparison, department-wise table, daily trend, login/logout records.
- **Profile drawer** – details, responsibilities, last 14 days of attendance, sessions, reporting history,
  direct reports, and (Super Admin) change manager or location with a reason.

## Where the numbers come from

- Attendance: `attendance` (check-in/out, `is_late`, `early_departure`, `total_minutes`).
- Leave: approved `leave_requests`. Holidays: `holidays` (global or per location) are not counted.
- Expected days run from each employee's joining date up to today. Today counts as absent until the
  employee checks in.
- Login/logout: `employee_login_audit` (written at sign-in and sign-out).
- Live status: presence (real keyboard/mouse/focus activity in the web app) + today's attendance.
- Section in use: the web app sends the route name (for example `tasks`) when the page changes.
  No page content is sent.

## Requested tables and where they live

| Requested | Implemented as |
|---|---|
| employees, departments | existing tables |
| reporting_hierarchy | `employees.manager_id` (current) |
| reporting_assignments | new `reporting_assignments` (history) |
| employee_locations | `employees.location_id` + existing `employee_locations` (extra managed locations) |
| attendance_records | existing `attendance` |
| employee_activity_logs, tracking_sessions | existing `employee_login_audit`, `employee_sessions`, `employee_status_events` |
| manager_permissions | roles/permissions (`hierarchy.view.all`, `hierarchy.manage`) + `employee_locations` |

## API

| Method | Path | Who |
|---|---|---|
| GET | `/api/hierarchy/overview?locationId=` | everyone (scoped) |
| GET | `/api/hierarchy/employees/:id` | in scope |
| GET | `/api/hierarchy/analytics?from&to&locationId` | managers (scoped) |
| PUT | `/api/hierarchy/employees/:id/assignment` `{managerId?, locationId?, reason?}` | `hierarchy.manage` |
| GET / PUT | `/api/hierarchy/locations/:id/managers` `{employeeIds}` | view in scope / `hierarchy.manage` |
| POST | `/api/hierarchy/rebuild` | `hierarchy.manage` |

## Other fixes made with this work

- Explicit logout never saved the logout time (the session was already revoked when the audit
  row was looked up). Fixed in `AuthService.logout`.
- `employee_roles` was never created by any active migration, so on such databases startup stopped
  before syncing roles. Migration 030 now creates it.
- Startup no longer deletes employees whose email is blank, and no longer clears the Super Admin's
  reporting manager on every restart.
- `subtreeIds` stops at reporting cycles instead of recursing to the database limit.
- Group endpoints: a broken import was fixed, and access now needs the permission itself rather than a
  role level of 70 or more.
