# Collections module

Customer payment collection register, connected to the same employee, department and location records as every other module.

## 1. What it does

- **Overview**: collected today and this month, outstanding balance, overdue balance, records awaiting approval, status mix and collected-by-department comparison.
- **Records**: searchable, filterable register with pagination, per-record detail, approval actions and exports.
- **Create / edit**: customer, contact, invoice, amount due, amount collected, payment mode, due date, collected date, collector, department, location and notes.
- **Approval workflow**: every new record starts `pending`; a manager with `collections.approve` approves or rejects it with a mandatory rejection reason. The collector is notified in-app and by email.
- **Exports**: Excel and PDF (`/api/exports?type=collections`) use the same filters as the table.

Status is derived server-side from the amounts, so it cannot drift:

| Condition | Status |
|---|---|
| collected ≥ amount due | `collected` |
| 0 < collected < amount due | `partial` |
| collected = 0 | `pending` |
| explicitly cancelled | `cancelled` |

Approval status is independent: `pending`, `approved`, `rejected`. Approved records can only be edited by a user with organisation-wide collection visibility.

## 2. Data model

`collections` (migration `009_collections.sql`):

| Column | Notes |
|---|---|
| `reference_no` | `COL-<year>-<sequence>`, unique, generated in a transaction from `system_settings.collection_seq` |
| `customer_name`, `customer_contact`, `invoice_no` | Customer identity |
| `amount_due`, `amount_collected`, `currency` | `DECIMAL(14,2)`, validated server-side (`collected ≤ due`, `due > 0`) |
| `payment_mode` | cash, upi, card, bank_transfer, cheque, other |
| `status`, `approval_status` | Workflow state |
| `due_date`, `collected_on` | Business dates |
| `employee_id` | Collector (drives visibility) |
| `department_id`, `location_id` | Default from the collector, overridable |
| `approved_by`, `approved_at`, `rejection_reason` | Approval trail |
| `created_by`, `deleted_at` | Authorship and soft deletion |

Indexes cover status + due date, approval status, collector, department, location, due date and creation time. Foreign keys reference `employees`, `departments` and `locations`; deleting a collector is prevented, preserving history.

## 3. Permissions and visibility

| Permission | Meaning |
|---|---|
| `collections.view.own` | Own records or records the user created |
| `collections.view.team` | Records for the reporting subtree |
| `collections.view.all` | Organisation-wide |
| `collections.create` | Create records |
| `collections.edit` | Edit records in scope |
| `collections.delete` | Archive records in scope |
| `collections.approve` | Approve or reject records in scope |

Visibility uses the recursive reporting subtree, exactly like tasks and tickets. Employees create and see their own collections; managers see and approve their team's; executives and administrators see the organisation. Assigning a record to someone outside the subtree returns `403`.

## 4. API

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/collections` | any view permission | `search,status,approvalStatus,employeeId,departmentId,locationId,from,to,page,pageSize` |
| GET | `/api/collections/dashboard` | any view permission | `from`, `to` (due-date range) |
| GET | `/api/collections/meta` | authenticated | status, approval and payment-mode options |
| GET | `/api/collections/:id` | scoped | record detail |
| POST | `/api/collections` | `collections.create` | returns `{ id, referenceNo }` |
| PATCH | `/api/collections/:id` | `collections.edit` | partial update; status recalculated |
| POST | `/api/collections/:id/decision` | `collections.approve` | `{ approve, reason? }` |
| DELETE | `/api/collections/:id` | `collections.delete` | soft delete, audited |
| GET | `/api/exports?type=collections&format=xlsx\|pdf\|csv` | any view permission | honours the register filters |

Every mutation writes an `audit_logs` entry (`collection.created`, `collection.updated`, `collection.approved`, `collection.rejected`, `collection.deleted`) and approval decisions create notifications for the collector.

## 5. UI

Sidebar → **Workspace → Collections** (`/collections`). The page has two tabs (Overview, Records), a shared filter bar (due-date range, status, approval, employee, department, location), a detail dialog with approve/reject/edit/delete actions gated by permission, and a create/edit form with client-side validation mirrored by Zod on the server. Direct URL navigation and browser history work because it is a normal route.

## 6. Verified

- Created a record through the API and UI; reference numbering continued correctly after the sequence migration.
- Status derived as `partial`, outstanding calculated as `36,000.00` from `48,000.00 − 12,000.00`.
- Employee cannot approve (`403`); manager sees and approves the team record; employee sees the approved state.
- Dashboard totals, status mix and recent records return real database values.
- Excel (7 KB) and PDF (1.8 KB) exports download successfully.
- Filtering by due-date range, employee, department and location applies server-side.
