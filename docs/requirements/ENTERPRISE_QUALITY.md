# ADDITIONAL MANDATORY DEVELOPMENT REQUIREMENTS
## Enterprise SaaS Quality, Professional UI/UX and Secure Environment Configuration

### 1. Centralized ENV Configuration

All email setup and third-party service configurations must be stored securely in environment variables.

Create properly structured files:

- `.env.example`
- `.env.local` for local development.
- `.env.production` for production server configuration, stored securely outside source control.

Never hardcode credentials, API keys, passwords, SMTP settings or secret tokens in source code.

### Email Configuration

Support SMTP-based email delivery with configurable providers.

Environment variables must include:

```env
# APPLICATION
NODE_ENV=
APP_NAME=
APP_URL=
FRONTEND_URL=
BACKEND_URL=

# DATABASE
DATABASE_URL=
DB_HOST=
DB_PORT=
DB_NAME=
DB_USER=
DB_PASSWORD=

# EMAIL / SMTP
SMTP_HOST=
SMTP_PORT=
SMTP_SECURE=
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM_NAME=
SMTP_FROM_EMAIL=
SMTP_REPLY_TO=

# OTP CONFIGURATION
OTP_EXPIRY_MINUTES=
OTP_RESEND_COOLDOWN_SECONDS=
OTP_MAX_ATTEMPTS=

# AUTHENTICATION
JWT_SECRET=
JWT_REFRESH_SECRET=
SESSION_SECRET=
COOKIE_SECRET=

# REDIS
REDIS_URL=

# WEBSOCKET
WEBSOCKET_URL=

# FILE STORAGE
STORAGE_PROVIDER=
STORAGE_BUCKET=
STORAGE_ACCESS_KEY=
STORAGE_SECRET_KEY=

# NOTIFICATIONS
WEB_PUSH_PUBLIC_KEY=
WEB_PUSH_PRIVATE_KEY=

# RATE LIMITING
RATE_LIMIT_WINDOW_MS=
RATE_LIMIT_MAX_REQUESTS=

# MEETING CONFIGURATION
MEETING_PROVIDER=
MEETING_API_KEY=
MEETING_API_SECRET=

# LOGGING
LOG_LEVEL=
```

Use only the variables required by the selected implementation. Do not expose secrets through frontend environment variables.

### Email functionality

Implement working email services for:

- New employee registration.
- Email verification.
- OTP login.
- Password reset.
- Account activation.
- Task allocation.
- Task reminders.
- Daily report reminders.
- Ticket assignment.
- Ticket resolution.
- Meeting invitations.
- Meeting reminders.
- Leave approval and rejection.
- Monthly KPI publication.
- Administrative announcements.

Create reusable email templates with professional HTML layouts.

Implement:
- SMTP connection verification.
- Email delivery error handling.
- Retry mechanisms.
- Email queue.
- Delivery status tracking.
- Failed email logs.
- Email templates.
- Configurable sender information.

Create an email configuration page accessible only to authorized administrators. Display connection status without revealing passwords or secret values.

Never commit actual `.env` files to GitHub. Add them to `.gitignore`. Provide a secure production secret-management process.

---

### 2. Professional Senior-Level UI/UX Design

The application must look like a professionally designed enterprise SaaS product developed by an experienced senior UI/UX designer and senior frontend engineer.

IMPORTANT: Avoid the typical AI-generated dashboard appearance.

Do not create:
- Unnecessary gradient backgrounds.
- Excessive rounded cards.
- Random decorative icons.
- Too many dashboard cards.
- Oversized headings.
- Unnecessary animations.
- Excessive shadows.
- Unwanted buttons.
- Duplicate navigation items.
- Repeated information.
- Decorative charts without business value.
- Fake statistics.
- Unnecessary empty sections.
- Complicated navigation.
- Excessive popups.
- Unwanted floating action buttons.

### Design direction

Use a clean, sophisticated enterprise interface.

Requirements:
- Professional typography.
- Consistent spacing system.
- Restrained color palette.
- Clear information hierarchy.
- Proper alignment.
- Subtle borders.
- Carefully selected icons.
- Clean tables.
- Compact but readable layouts.
- Clear status indicators.
- Consistent buttons.
- Accessible forms.
- Professional dashboards.

Use a consistent design system across every module.

### 3. User-Friendly Navigation

The system must be extremely easy to understand and operate.

Create role-specific navigation.

Employees should see only the modules they need.

Managers should see:
- Team Overview.
- Task Allocation.
- Employee Follow-up.
- Daily Reports.
- Team Attendance.
- Tickets.
- Meetings.
- Performance.

HR should see:
- Employee Management.
- Recruitment.
- Attendance.
- Leave Management.
- Payroll-related access where authorized.
- Performance.
- HR Reports.

Administrators should see:
- Organization Management.
- Roles and Permissions.
- System Configuration.
- Email Configuration.
- Security.
- Audit Logs.
- System Reports.

Avoid displaying every module to every user.

Use logical menus, clear labels and predictable navigation.

### 4. Functional UI Requirements

Every visible control must have a genuine purpose.

- Every button must perform its intended action.
- Every form must validate inputs.
- Every dropdown must contain actual options.
- Every filter must work.
- Every search must return real results.
- Every table action must work.
- Every modal must save or cancel correctly.
- Every notification must link to its related record.
- Every page must handle loading, errors and empty states.

Remove all unused buttons and placeholder controls.

Do not create buttons simply to make the dashboard look complete.

### 5. Enterprise Performance Requirements

Optimize the entire application for production usage.

Implement:
- Efficient API requests.
- Database query optimization.
- Proper indexing.
- Pagination.
- Server-side filtering.
- Lazy loading.
- Caching.
- Background job processing.
- WebSocket event optimization.
- Automatic reconnection.
- Error boundaries.
- Request timeouts.
- Proper loading skeletons.

Users must not need to refresh pages manually to view updated data.

Avoid unnecessary repeated API requests.

### 6. Complete Production Email and Notification Integration

Email, in-app notifications and WebSocket notifications must be connected.

Example:

Manager assigns a task:
1. Task is saved in MySQL.
2. Notification is created.
3. WebSocket event is sent.
4. Employee receives an in-app notification.
5. Email is queued.
6. Delivery status is recorded.

If email fails, the task must still remain saved and the system must retry email delivery according to its retry policy.

### 7. Production-Ready Validation

Before deployment, verify:

- SMTP credentials load from ENV.
- Email verification works.
- OTP delivery works.
- Password reset emails work.
- All email templates render correctly.
- Email failures are logged.
- Secrets are not exposed.
- ENV files are excluded from Git.
- Database connections work.
- All APIs work.
- WebSocket communication works.
- Role permissions work.
- Attendance tracking works.
- Task allocation works.
- Notifications work.
- Mobile responsiveness works.

### 8. Final Quality Standard

The final project must meet the standards of a professional enterprise SaaS platform.

I need:
- Clean and maintainable code.
- Consistent architecture.
- Professional UI/UX.
- Secure environment configuration.
- Real database integration.
- Reliable email delivery.
- Real-time synchronization.
- Correct employee hierarchy.
- Fully working business workflows.
- Responsive mobile experience.
- Complete documentation.
- Automated testing.
- Production deployment readiness.

Do not sacrifice functionality for appearance or appearance for functionality.

Do not add features that are unnecessary for the actual workflow.

**FINAL INSTRUCTION: Build a simple-to-use but technically powerful enterprise SaaS platform. The interface should feel like a mature commercial software product, not an AI-generated template or prototype. Every feature must be useful, every interaction must work, and all critical data must be securely persisted.**