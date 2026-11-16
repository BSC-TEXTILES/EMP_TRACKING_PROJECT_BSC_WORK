export interface PermissionDefinition {
  code: string;
  module: string;
  action: string;
  description: string;
}

/**
 * Canonical permission catalogue. The seed script persists these rows and maps
 * them onto roles; serverside guards reference the same strings.
 */
export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  { code: 'dashboard.view', module: 'dashboard', action: 'view', description: 'View personal dashboard' },
  { code: 'admin.dashboard', module: 'admin', action: 'dashboard', description: 'View company-wide admin dashboard' },

  { code: 'attendance.view.own', module: 'attendance', action: 'view.own', description: 'View own attendance' },
  { code: 'attendance.view.team', module: 'attendance', action: 'view.team', description: 'View team attendance' },
  { code: 'attendance.view.all', module: 'attendance', action: 'view.all', description: 'View organisation attendance' },
  { code: 'attendance.manage', module: 'attendance', action: 'manage', description: 'Manage and correct attendance' },
  { code: 'attendance.corrections.approve', module: 'attendance', action: 'corrections.approve', description: 'Approve attendance corrections' },

  { code: 'tasks.view.own', module: 'tasks', action: 'view.own', description: 'View own tasks' },
  { code: 'tasks.view.team', module: 'tasks', action: 'view.team', description: 'View team tasks' },
  { code: 'tasks.view.all', module: 'tasks', action: 'view.all', description: 'View all tasks' },
  { code: 'tasks.create', module: 'tasks', action: 'create', description: 'Create and allocate tasks' },
  { code: 'tasks.assign', module: 'tasks', action: 'assign', description: 'Assign tasks to employees' },
  { code: 'tasks.approve', module: 'tasks', action: 'approve', description: 'Review and approve task completion' },
  { code: 'tasks.delete', module: 'tasks', action: 'delete', description: 'Archive tasks' },

  { code: 'reports.view.own', module: 'reports', action: 'view.own', description: 'View own daily work reports' },
  { code: 'reports.view.team', module: 'reports', action: 'view.team', description: 'View team daily work reports' },
  { code: 'reports.view.all', module: 'reports', action: 'view.all', description: 'View all daily work reports' },
  { code: 'reports.review', module: 'reports', action: 'review', description: 'Approve or return daily reports' },

  { code: 'chat.use', module: 'chat', action: 'use', description: 'Use internal messaging' },
  { code: 'chat.groups.manage', module: 'chat', action: 'groups.manage', description: 'Create and manage chat groups' },
  { code: 'chat.moderate', module: 'chat', action: 'moderate', description: 'Moderate conversations' },

  { code: 'tickets.create', module: 'tickets', action: 'create', description: 'Raise support tickets' },
  { code: 'tickets.view.own', module: 'tickets', action: 'view.own', description: 'View own tickets' },
  { code: 'tickets.view.team', module: 'tickets', action: 'view.team', description: 'View team tickets' },
  { code: 'tickets.view.all', module: 'tickets', action: 'view.all', description: 'View all tickets' },
  { code: 'tickets.assign', module: 'tickets', action: 'assign', description: 'Assign tickets' },
  { code: 'tickets.resolve', module: 'tickets', action: 'resolve', description: 'Progress and resolve tickets' },
  { code: 'tickets.manage', module: 'tickets', action: 'manage', description: 'Configure ticket workflow' },

  { code: 'notifications.send', module: 'notifications', action: 'send', description: 'Send bulk announcements' },

  { code: 'meetings.create', module: 'meetings', action: 'create', description: 'Schedule meetings' },
  { code: 'meetings.manage', module: 'meetings', action: 'manage', description: 'Manage any meeting' },

  { code: 'kpi.view.own', module: 'kpi', action: 'view.own', description: 'View own KPI results' },
  { code: 'kpi.view.team', module: 'kpi', action: 'view.team', description: 'View team KPI results' },
  { code: 'kpi.view.all', module: 'kpi', action: 'view.all', description: 'View organisation KPI results' },
  { code: 'kpi.configure', module: 'kpi', action: 'configure', description: 'Configure KPI templates and weights' },
  { code: 'kpi.review', module: 'kpi', action: 'review', description: 'Review and adjust KPI evaluations' },
  { code: 'kpi.publish', module: 'kpi', action: 'publish', description: 'Publish monthly KPI evaluations' },

  { code: 'leave.apply', module: 'leave', action: 'apply', description: 'Apply for leave' },
  { code: 'leave.view.own', module: 'leave', action: 'view.own', description: 'View own leave' },
  { code: 'leave.view.team', module: 'leave', action: 'view.team', description: 'View team leave' },
  { code: 'leave.view.all', module: 'leave', action: 'view.all', description: 'View all leave requests' },
  { code: 'leave.approve.manager', module: 'leave', action: 'approve.manager', description: 'Manager leave approval' },
  { code: 'leave.approve.hr', module: 'leave', action: 'approve.hr', description: 'HR leave approval' },
  { code: 'leave.manage', module: 'leave', action: 'manage', description: 'Configure leave types and balances' },

  { code: 'employees.view.own', module: 'employees', action: 'view.own', description: 'View own profile' },
  { code: 'employees.view.team', module: 'employees', action: 'view.team', description: 'View reporting employees' },
  { code: 'employees.view.all', module: 'employees', action: 'view.all', description: 'View all employee records' },
  { code: 'employees.manage', module: 'employees', action: 'manage', description: 'Create and update employees' },
  { code: 'employees.approve', module: 'employees', action: 'approve', description: 'Approve new registrations' },

  { code: 'collections.view.own', module: 'collections', action: 'view.own', description: 'View own collection records' },
  { code: 'collections.view.team', module: 'collections', action: 'view.team', description: 'View team collection records' },
  { code: 'collections.view.all', module: 'collections', action: 'view.all', description: 'View all collection records' },
  { code: 'collections.create', module: 'collections', action: 'create', description: 'Create collection records' },
  { code: 'collections.edit', module: 'collections', action: 'edit', description: 'Edit collection records' },
  { code: 'collections.delete', module: 'collections', action: 'delete', description: 'Delete collection records' },
  { code: 'collections.approve', module: 'collections', action: 'approve', description: 'Approve or reject collection records' },

  { code: 'activity.view.own', module: 'activity', action: 'view.own', description: 'View own monitored activity' },
  { code: 'activity.view.team', module: 'activity', action: 'view.team', description: 'View team activity and daily summaries' },
  { code: 'activity.view.all', module: 'activity', action: 'view.all', description: 'View organisation-wide activity analytics' },
  { code: 'activity.review', module: 'activity', action: 'review', description: 'Review daily activity and weekly performance' },
  { code: 'activity.devices.manage', module: 'activity', action: 'devices.manage', description: 'Register and revoke monitoring devices' },
  { code: 'activity.policy.manage', module: 'activity', action: 'policy.manage', description: 'Configure monitoring policy and retention' },

  { code: 'roles.manage', module: 'roles', action: 'manage', description: 'Manage roles and permission matrix' },
  { code: 'org.manage', module: 'org', action: 'manage', description: 'Manage departments, designations and locations' },

  { code: 'projects.view', module: 'projects', action: 'view', description: 'View projects' },
  { code: 'projects.create', module: 'projects', action: 'create', description: 'Create projects' },
  { code: 'projects.manage', module: 'projects', action: 'manage', description: 'Manage projects and milestones' },

  { code: 'analytics.view', module: 'analytics', action: 'view', description: 'View team analytics' },
  { code: 'analytics.view.all', module: 'analytics', action: 'view.all', description: 'View organisation analytics' },
  { code: 'reports.export', module: 'exports', action: 'export', description: 'Download CSV/Excel/PDF reports' },
  { code: 'audit.view', module: 'audit', action: 'view', description: 'View audit trail' },
  { code: 'settings.manage', module: 'settings', action: 'manage', description: 'Manage system settings' },
];

export const P = Object.fromEntries(PERMISSION_DEFINITIONS.map((p) => [p.code, p.code])) as Record<string, string>;

export const ALL_PERMISSIONS = PERMISSION_DEFINITIONS.map((p) => p.code);

export const EMPLOYEE_BASE_PERMISSIONS = [
  'dashboard.view',
  'attendance.view.own',
  'tasks.view.own',
  'reports.view.own',
  'chat.use',
  'tickets.create',
  'tickets.view.own',
  'kpi.view.own',
  'leave.apply',
  'leave.view.own',
  'employees.view.own',
  'projects.view',
  'meetings.create',
  'notifications.send',
  'collections.view.own',
  'collections.create',
  'activity.view.own',
].filter((code) => code !== 'notifications.send');

export const MANAGER_PERMISSIONS = [
  ...EMPLOYEE_BASE_PERMISSIONS,
  'attendance.view.team',
  'attendance.corrections.approve',
  'tasks.view.team',
  'tasks.create',
  'tasks.assign',
  'tasks.approve',
  'reports.view.team',
  'reports.review',
  'tickets.view.team',
  'tickets.assign',
  'tickets.resolve',
  'kpi.view.team',
  'kpi.review',
  'leave.view.team',
  'leave.approve.manager',
  'employees.view.team',
  'meetings.create',
  'analytics.view',
  'reports.export',
  'projects.create',
  'collections.view.team',
  'collections.edit',
  'collections.approve',
  'activity.view.team',
  'activity.review',
];

export const HR_PERMISSIONS = [
  ...MANAGER_PERMISSIONS,
  ...ALL_PERMISSIONS.filter((code) => code.startsWith('employees.') || code.startsWith('attendance.') || code.startsWith('leave.')),
  'kpi.view.all',
  'kpi.publish',
  'reports.view.all',
  'analytics.view.all',
  'notifications.send',
  'audit.view',
  'org.manage',
  'collections.view.all',
  'activity.view.all',
  'activity.policy.manage',
];

export const IT_ADMIN_PERMISSIONS = [
  ...MANAGER_PERMISSIONS,
  'tickets.view.all',
  'tickets.manage',
  'employees.manage',
  'settings.manage',
  'audit.view',
  'notifications.send',
  'activity.view.all',
  'activity.devices.manage',
  'activity.policy.manage',
];

export const ROLE_DEFINITIONS: {
  slug: string;
  name: string;
  category: string;
  level: number;
  description: string;
  permissions: string[];
}[] = [
  {
    slug: 'super_admin',
    name: 'Super Admin',
    category: 'executive',
    level: 100,
    description: 'Unrestricted control over the entire organisation and platform configuration.',
    permissions: ALL_PERMISSIONS,
  },
  {
    slug: 'company_owner',
    name: 'Company Owner',
    category: 'executive',
    level: 95,
    description: 'Full organisational visibility and governance.',
    permissions: ALL_PERMISSIONS.filter((c) => c !== 'settings.manage' || true),
  },
  {
    slug: 'executive',
    name: 'Executive Leadership',
    category: 'executive',
    level: 90,
    description: 'CEO / MD / COO / CTO / CFO - company-wide oversight.',
    permissions: [
      ...HR_PERMISSIONS,
      'roles.manage',
      'settings.manage',
      'employees.view.all',
      'employees.manage',
      'kpi.configure',
      'kpi.publish',
      'notifications.send',
      'audit.view',
      'admin.dashboard',
      'collections.view.all',
      'collections.delete',
    ],
  },
  {
    slug: 'general_manager',
    name: 'General Manager',
    category: 'executive',
    level: 80,
    description: 'Multi-department operational leadership.',
    permissions: [...MANAGER_PERMISSIONS, 'employees.view.all', 'kpi.view.all', 'analytics.view.all', 'admin.dashboard', 'notifications.send', 'collections.view.all', 'collections.delete'],
  },
  {
    slug: 'department_head',
    name: 'Department Head',
    category: 'management',
    level: 70,
    description: 'Owns a department, its people, delivery and KPIs.',
    permissions: [...MANAGER_PERMISSIONS, 'kpi.view.all', 'notifications.send', 'jobs.view'],
  },
  {
    slug: 'manager',
    name: 'Manager',
    category: 'management',
    level: 60,
    description: 'Manages a reporting team, tasks, reports and approvals.',
    permissions: MANAGER_PERMISSIONS,
  },
  {
    slug: 'hr_manager',
    name: 'HR Manager',
    category: 'hr',
    level: 65,
    description: 'HR operations, employee records, leave and attendance governance.',
    permissions: HR_PERMISSIONS,
  },
  {
    slug: 'hr_executive',
    name: 'HR Executive',
    category: 'hr',
    level: 40,
    description: 'HR coordination and employee support.',
    permissions: [
      ...EMPLOYEE_BASE_PERMISSIONS,
      'employees.view.all',
      'attendance.view.all',
      'leave.view.all',
      'reports.view.team',
      'notifications.send',
      'reports.export',
      'collections.view.all',
    ],
  },
  {
    slug: 'it_admin',
    name: 'IT Administrator',
    category: 'it',
    level: 55,
    description: 'IT service desk, ticket workflow and systems administration.',
    permissions: IT_ADMIN_PERMISSIONS,
  },
  {
    slug: 'helpdesk',
    name: 'IT Helpdesk Executive',
    category: 'it',
    level: 30,
    description: 'First-line support and ticket triage.',
    permissions: [...EMPLOYEE_BASE_PERMISSIONS, 'tickets.view.all', 'tickets.resolve', 'tickets.assign'],
  },
  {
    slug: 'store_manager',
    name: 'Store Manager',
    category: 'retail',
    level: 50,
    description: 'Retail location management with location-scoped access.',
    permissions: [...MANAGER_PERMISSIONS, 'attendance.view.all', 'reports.view.all'],
  },
  {
    slug: 'payroll_admin',
    name: 'Payroll Administrator',
    category: 'hr',
    level: 45,
    description: 'Payroll and attendance data stewardship.',
    permissions: [...EMPLOYEE_BASE_PERMISSIONS, 'attendance.view.all', 'attendance.manage', 'leave.view.all', 'reports.export', 'employees.view.all'],
  },
  {
    slug: 'employee',
    name: 'Employee',
    category: 'general',
    level: 10,
    description: 'Standard employee self-service access.',
    permissions: EMPLOYEE_BASE_PERMISSIONS,
  },
];
