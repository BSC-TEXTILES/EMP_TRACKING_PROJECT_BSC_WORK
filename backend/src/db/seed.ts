/**
 * Seeds the Workforce platform.
 *
 * Reference data (permissions, roles, departments, designations, locations,
 * leave types, holidays, settings) is upserted safely. Transactional demo data
 * (attendance, tasks, reports, chats, tickets, meetings, KPI) is only inserted
 * when the database has no tasks yet, so re-running never overwrites live data.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { execute, pool, query, queryOne } from './index.js';
import { runMigrations } from './migrate.js';
import { hashPassword } from '../lib/crypto.js';
import { addDays, addMonths, endOfMonth, periodOf, startOfMonth, today, toSql, zonedToUtc } from '../lib/dates.js';
import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS } from '../lib/rbac.js';
import { SETTING_DEFAULTS } from '../lib/audit.js';
import { KpiService } from '../services/KpiService.js';

const DEMO_PASSWORD = 'Workforce@2026';

const DEPARTMENTS = [
  { code: 'EXEC', name: 'Executive Office', description: 'Company leadership and governance' },
  { code: 'HR', name: 'HR & Administration', description: 'People operations, payroll and administration' },
  { code: 'IT', name: 'IT & Technology', description: 'Engineering, infrastructure and support' },
  { code: 'MKT', name: 'Digital & Marketing', description: 'Brand, content, performance marketing' },
  { code: 'OPS', name: 'Data & Business Operations', description: 'Analytics, MIS and business operations' },
  { code: 'RETAIL', name: 'Retail Operations', description: 'Stores, sales and customer experience' },
  { code: 'FIN', name: 'Finance', description: 'Accounts, payroll and compliance' },
];

const DESIGNATIONS: { title: string; dept: string; level: number }[] = [
  // Executive
  { title: 'Owner', dept: 'EXEC', level: 20 },
  { title: 'Managing Director', dept: 'EXEC', level: 20 },
  { title: 'Chief Executive Officer', dept: 'EXEC', level: 20 },
  { title: 'Chief Operating Officer', dept: 'EXEC', level: 19 },
  { title: 'Chief Technology Officer', dept: 'EXEC', level: 19 },
  { title: 'Chief Financial Officer', dept: 'EXEC', level: 19 },
  { title: 'General Manager', dept: 'EXEC', level: 17 },
  { title: 'Deputy General Manager', dept: 'EXEC', level: 16 },
  { title: 'Operations Manager', dept: 'OPS', level: 15 },
  { title: 'Regional Manager', dept: 'RETAIL', level: 15 },
  { title: 'Branch Manager', dept: 'RETAIL', level: 14 },
  { title: 'Department Head', dept: 'EXEC', level: 16 },
  // HR & Admin
  { title: 'HR Director', dept: 'HR', level: 18 },
  { title: 'HR Manager', dept: 'HR', level: 15 },
  { title: 'HR Executive', dept: 'HR', level: 9 },
  { title: 'HR Recruiter', dept: 'HR', level: 9 },
  { title: 'HR Coordinator', dept: 'HR', level: 8 },
  { title: 'Payroll Administrator', dept: 'FIN', level: 11 },
  { title: 'Payroll Manager', dept: 'HR', level: 13 },
  { title: 'Payroll Executive', dept: 'HR', level: 8 },
  { title: 'HR Administrator', dept: 'HR', level: 10 },
  { title: 'Admin Manager', dept: 'HR', level: 13 },
  { title: 'Admin Executive', dept: 'HR', level: 8 },
  { title: 'Office Administrator', dept: 'HR', level: 7 },
  // IT
  { title: 'IT Head', dept: 'IT', level: 18 },
  { title: 'IT Manager', dept: 'IT', level: 15 },
  { title: 'IT Administrator', dept: 'IT', level: 12 },
  { title: 'Software Developer', dept: 'IT', level: 9 },
  { title: 'Frontend Developer', dept: 'IT', level: 9 },
  { title: 'Backend Developer', dept: 'IT', level: 9 },
  { title: 'Full Stack Developer', dept: 'IT', level: 10 },
  { title: 'Mobile App Developer', dept: 'IT', level: 9 },
  { title: 'UI/UX Designer', dept: 'IT', level: 9 },
  { title: 'QA Engineer', dept: 'IT', level: 8 },
  { title: 'Software Tester', dept: 'IT', level: 7 },
  { title: 'DevOps Engineer', dept: 'IT', level: 11 },
  { title: 'Network Administrator', dept: 'IT', level: 10 },
  { title: 'System Administrator', dept: 'IT', level: 10 },
  { title: 'Cybersecurity Engineer', dept: 'IT', level: 11 },
  { title: 'Database Administrator', dept: 'IT', level: 11 },
  { title: 'IT Support Executive', dept: 'IT', level: 8 },
  { title: 'Helpdesk Technician', dept: 'IT', level: 6 },
  // Digital & Marketing
  { title: 'Digital Marketing Manager', dept: 'MKT', level: 15 },
  { title: 'SEO Executive', dept: 'MKT', level: 9 },
  { title: 'Social Media Manager', dept: 'MKT', level: 11 },
  { title: 'Content Writer', dept: 'MKT', level: 7 },
  { title: 'Graphic Designer', dept: 'MKT', level: 7 },
  { title: 'Video Editor', dept: 'MKT', level: 7 },
  { title: 'Performance Marketing Executive', dept: 'MKT', level: 8 },
  { title: 'Digital Marketing Executive', dept: 'MKT', level: 8 },
  { title: 'Marketing Analyst', dept: 'MKT', level: 9 },
  // Data & business operations
  { title: 'Data Analyst', dept: 'OPS', level: 9 },
  { title: 'Business Analyst', dept: 'OPS', level: 10 },
  { title: 'MIS Executive', dept: 'OPS', level: 7 },
  { title: 'Reporting Executive', dept: 'OPS', level: 8 },
  { title: 'Operations Analyst', dept: 'OPS', level: 8 },
  { title: 'Business Development Executive', dept: 'OPS', level: 8 },
  { title: 'Customer Support Executive', dept: 'OPS', level: 6 },
  { title: 'CRM Manager', dept: 'OPS', level: 13 },
  { title: 'CRM Executive', dept: 'OPS', level: 7 },
  { title: 'Sales Executive', dept: 'OPS', level: 6 },
  { title: 'Telecaller', dept: 'OPS', level: 4 },
  { title: 'Sales Executive', dept: 'RETAIL', level: 6 },
  // Retail & store operations
  { title: 'Retail Head', dept: 'RETAIL', level: 18 },
  { title: 'Store Manager', dept: 'RETAIL', level: 14 },
  { title: 'Assistant Store Manager', dept: 'RETAIL', level: 12 },
  { title: 'Floor Manager', dept: 'RETAIL', level: 11 },
  { title: 'Department Manager', dept: 'RETAIL', level: 11 },
  { title: 'Sales Manager', dept: 'RETAIL', level: 13 },
  { title: 'Salesman', dept: 'RETAIL', level: 4 },
  { title: 'Cashier', dept: 'RETAIL', level: 3 },
  { title: 'Billing Executive', dept: 'RETAIL', level: 4 },
  { title: 'Stock Manager', dept: 'RETAIL', level: 9 },
  { title: 'Inventory Executive', dept: 'RETAIL', level: 6 },
  { title: 'Visual Merchandiser', dept: 'RETAIL', level: 6 },
  { title: 'Customer Relationship Executive', dept: 'RETAIL', level: 6 },
  { title: 'Store Support Executive', dept: 'RETAIL', level: 3 },
  // Finance
  { title: 'Finance Manager', dept: 'FIN', level: 14 },
  { title: 'Accounts Executive', dept: 'FIN', level: 8 },
  { title: 'Accounts Payable Executive', dept: 'FIN', level: 7 },
  { title: 'Taxation Executive', dept: 'FIN', level: 8 },
  { title: 'Internal Auditor', dept: 'FIN', level: 11 },
];

const LOCATIONS = [
  { code: 'BEL', name: 'Belagavi', city: 'Belagavi', address: null as string | null, lat: null as number | null, lng: null as number | null, radius: null as number | null },
  { code: 'DAV', name: 'Davanagere', city: 'Davanagere', address: null as string | null, lat: null as number | null, lng: null as number | null, radius: null as number | null },
  { code: 'SHI', name: 'Shivamogga', city: 'Shivamogga', address: null as string | null, lat: null as number | null, lng: null as number | null, radius: null as number | null },
];

const EMPLOYEES = [
  { code: 'EMP-1001', name: 'Aarti Sharma', email: 'admin@bsctextiles.in', mobile: '9810000001', role: 'super_admin', dept: 'EXEC', designation: 'Managing Director', manager: null, location: 'BEL' },
  { code: 'EMP-1002', name: 'Rajesh Menon', email: 'ceo@bsctextiles.in', mobile: '9810000002', role: 'executive', dept: 'EXEC', designation: 'Chief Executive Officer', manager: 'EMP-1001', location: 'BEL' },
  { code: 'EMP-1003', name: 'Priya Nair', email: 'coo@bsctextiles.in', mobile: '9810000003', role: 'executive', dept: 'EXEC', designation: 'Chief Operating Officer', manager: 'EMP-1002', location: 'BEL' },
  { code: 'EMP-1004', name: 'Vikram Singh', email: 'vikram.singh@bsctextiles.in', mobile: '9810000004', role: 'general_manager', dept: 'OPS', designation: 'General Manager', manager: 'EMP-1003', location: 'BEL' },
  { code: 'EMP-1005', name: 'Neha Kapoor', email: 'hr.manager@bsctextiles.in', mobile: '9810000005', role: 'hr_manager', dept: 'HR', designation: 'HR Manager', manager: 'EMP-1003', location: 'BEL' },
  { code: 'EMP-1006', name: 'Simran Kaur', email: 'hr.exec@bsctextiles.in', mobile: '9810000006', role: 'hr_executive', dept: 'HR', designation: 'HR Executive', manager: 'EMP-1005', location: 'BEL' },
  { code: 'EMP-1007', name: 'Arjun Patel', email: 'it.manager@bsctextiles.in', mobile: '9810000007', role: 'manager', dept: 'IT', designation: 'IT Manager', manager: 'EMP-1003', location: 'BEL' },
  { code: 'EMP-1008', name: 'Rohan Gupta', email: 'it.admin@bsctextiles.in', mobile: '9810000008', role: 'it_admin', dept: 'IT', designation: 'IT Administrator', manager: 'EMP-1007', location: 'BEL' },
  { code: 'EMP-1009', name: 'Ananya Rao', email: 'ananya.rao@bsctextiles.in', mobile: '9810000009', role: 'employee', dept: 'IT', designation: 'Frontend Developer', manager: 'EMP-1007', location: 'BEL' },
  { code: 'EMP-1010', name: 'Karthik Iyer', email: 'karthik.iyer@bsctextiles.in', mobile: '9810000010', role: 'employee', dept: 'IT', designation: 'Backend Developer', manager: 'EMP-1007', location: 'BEL' },
  { code: 'EMP-1011', name: 'Meera Joshi', email: 'meera.joshi@bsctextiles.in', mobile: '9810000011', role: 'employee', dept: 'IT', designation: 'QA Engineer', manager: 'EMP-1007', location: 'DAV' },
  { code: 'EMP-1012', name: 'Sanjay Verma', email: 'marketing.manager@bsctextiles.in', mobile: '9810000012', role: 'manager', dept: 'MKT', designation: 'Digital Marketing Manager', manager: 'EMP-1003', location: 'BEL' },
  { code: 'EMP-1013', name: 'Divya Desai', email: 'divya.desai@bsctextiles.in', mobile: '9810000013', role: 'employee', dept: 'MKT', designation: 'Content Writer', manager: 'EMP-1012', location: 'BEL' },
  { code: 'EMP-1014', name: 'Aditya Kulkarni', email: 'aditya.kulkarni@bsctextiles.in', mobile: '9810000014', role: 'employee', dept: 'MKT', designation: 'Graphic Designer', manager: 'EMP-1012', location: 'BEL' },
  { code: 'EMP-1015', name: 'Pooja Reddy', email: 'pooja.reddy@bsctextiles.in', mobile: '9810000015', role: 'employee', dept: 'OPS', designation: 'Data Analyst', manager: 'EMP-1004', location: 'BEL' },
  { code: 'EMP-1016', name: 'Farhan Khan', email: 'store.manager@bsctextiles.in', mobile: '9810000016', role: 'store_manager', dept: 'RETAIL', designation: 'Store Manager', manager: 'EMP-1004', location: 'SHI' },
  { code: 'EMP-1017', name: 'Ritu Bansal', email: 'ritu.bansal@bsctextiles.in', mobile: '9810000017', role: 'employee', dept: 'RETAIL', designation: 'Cashier', manager: 'EMP-1016', location: 'SHI' },
  { code: 'EMP-1018', name: 'Manish Yadav', email: 'manish.yadav@bsctextiles.in', mobile: '9810000018', role: 'employee', dept: 'RETAIL', designation: 'Sales Executive', manager: 'EMP-1016', location: 'DAV' },
  { code: 'EMP-1019', name: 'Isha Malhotra', email: 'isha.malhotra@bsctextiles.in', mobile: '9810000019', role: 'employee', dept: 'MKT', designation: 'Content Writer', manager: 'EMP-1012', location: 'BEL', status: 'pending_approval' },
];

async function seedReferenceData(): Promise<void> {
  for (const permission of PERMISSION_DEFINITIONS) {
    await execute(
      `INSERT INTO permissions (code, module, action, description) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE module = VALUES(module), action = VALUES(action), description = VALUES(description)`,
      [permission.code, permission.module, permission.action, permission.description],
    );
  }

  for (const role of ROLE_DEFINITIONS) {
    await execute(
      `INSERT INTO roles (name, slug, category, level, description, is_system) VALUES (?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE name = VALUES(name), category = VALUES(category), level = VALUES(level), description = VALUES(description)`,
      [role.name, role.slug, role.category, role.level, role.description],
    );
    const roleRow = await queryOne<{ id: number }>('SELECT id FROM roles WHERE slug = ?', [role.slug]);
    if (!roleRow) continue;
    const permissionRows = await query<{ id: number; code: string }>('SELECT id, code FROM permissions');
    const byCode = new Map(permissionRows.map((p) => [p.code, Number(p.id)]));
    for (const code of new Set(role.permissions)) {
      const permissionId = byCode.get(code);
      if (!permissionId) continue;
      await execute('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [roleRow.id, permissionId]);
    }
  }

  for (const department of DEPARTMENTS) {
    await execute(
      `INSERT INTO departments (name, code, description) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
      [department.name, department.code, department.description],
    );
  }
  const departments = new Map(
    (await query<{ id: number; code: string }>('SELECT id, code FROM departments')).map((d) => [d.code, Number(d.id)]),
  );

  for (const designation of DESIGNATIONS) {
    await execute(
      `INSERT INTO designations (title, code, department_id, level) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE level = VALUES(level)`,
      [
        designation.title,
        `${designation.dept}-${designation.title.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}`.slice(0, 32),
        departments.get(designation.dept) ?? null,
        designation.level,
      ],
    );
  }

  // Standard reporting lines (child designation -> designation it reports to), set only where missing.
  const reporting: [string, string][] = [
    ['Managing Director', 'Owner'], ['Chief Executive Officer', 'Managing Director'], ['Chief Operating Officer', 'Chief Executive Officer'],
    ['Chief Technology Officer', 'Chief Executive Officer'], ['Chief Financial Officer', 'Chief Executive Officer'], ['General Manager', 'Chief Operating Officer'],
    ['Deputy General Manager', 'General Manager'], ['Operations Manager', 'General Manager'], ['Department Head', 'General Manager'],
    ['Retail Head', 'Chief Operating Officer'], ['Regional Manager', 'Retail Head'], ['Branch Manager', 'Regional Manager'],
    ['HR Director', 'Chief Executive Officer'], ['HR Manager', 'HR Director'], ['HR Executive', 'HR Manager'], ['HR Recruiter', 'HR Manager'],
    ['HR Coordinator', 'HR Manager'], ['HR Administrator', 'HR Manager'], ['Payroll Manager', 'HR Director'], ['Payroll Executive', 'Payroll Manager'],
    ['IT Head', 'Chief Technology Officer'], ['IT Manager', 'IT Head'], ['IT Administrator', 'IT Manager'], ['Software Developer', 'IT Manager'],
    ['Frontend Developer', 'IT Manager'], ['Backend Developer', 'IT Manager'], ['Full Stack Developer', 'IT Manager'], ['Mobile App Developer', 'IT Manager'],
    ['UI/UX Designer', 'IT Manager'], ['QA Engineer', 'IT Manager'], ['Software Tester', 'QA Engineer'], ['DevOps Engineer', 'IT Manager'],
    ['Network Administrator', 'IT Administrator'], ['System Administrator', 'IT Administrator'], ['Cybersecurity Engineer', 'IT Manager'],
    ['Database Administrator', 'IT Manager'], ['IT Support Executive', 'IT Administrator'], ['Helpdesk Technician', 'IT Support Executive'],
    ['Digital Marketing Manager', 'General Manager'], ['SEO Executive', 'Digital Marketing Manager'], ['Social Media Manager', 'Digital Marketing Manager'],
    ['Content Writer', 'Social Media Manager'], ['Graphic Designer', 'Digital Marketing Manager'], ['Video Editor', 'Digital Marketing Manager'],
    ['Performance Marketing Executive', 'Digital Marketing Manager'], ['Business Analyst', 'Operations Manager'], ['Data Analyst', 'Business Analyst'],
    ['MIS Executive', 'Business Analyst'], ['Reporting Executive', 'Business Analyst'], ['CRM Manager', 'Operations Manager'], ['CRM Executive', 'CRM Manager'],
    ['Customer Support Executive', 'CRM Manager'], ['Telecaller', 'CRM Manager'], ['Business Development Executive', 'Operations Manager'],
    ['Store Manager', 'Retail Head'], ['Assistant Store Manager', 'Store Manager'], ['Floor Manager', 'Assistant Store Manager'],
    ['Department Manager', 'Store Manager'], ['Sales Manager', 'Store Manager'], ['Salesman', 'Floor Manager'], ['Cashier', 'Store Manager'],
    ['Billing Executive', 'Store Manager'], ['Stock Manager', 'Store Manager'], ['Inventory Executive', 'Stock Manager'], ['Visual Merchandiser', 'Store Manager'],
    ['Customer Relationship Executive', 'Store Manager'], ['Store Support Executive', 'Assistant Store Manager'],
  ];
  for (const [child, parent] of reporting) {
    await execute(
      `UPDATE designations c JOIN (SELECT id FROM designations WHERE title = ? ORDER BY id LIMIT 1) p ON p.id <> c.id
       SET c.reporting_designation_id = p.id WHERE c.title = ? AND c.reporting_designation_id IS NULL`,
      [parent, child],
    );
  }

  for (const location of LOCATIONS) {
    await execute(
      `INSERT INTO locations (name, code, city, address, latitude, longitude, geofence_radius_m, timezone)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Asia/Kolkata')
       ON DUPLICATE KEY UPDATE name = VALUES(name), city = VALUES(city), address = VALUES(address)`,
      [location.name, location.code, location.city, location.address, location.lat, location.lng, location.radius],
    );
  }

  const leaveTypes = [
    { code: 'CL', name: 'Casual Leave', quota: 12, paid: 1, doc: 0 },
    { code: 'SL', name: 'Sick Leave', quota: 10, paid: 1, doc: 0 },
    { code: 'EL', name: 'Earned Leave', quota: 18, paid: 1, doc: 0 },
    { code: 'ML', name: 'Maternity Leave', quota: 182, paid: 1, doc: 1 },
    { code: 'PL', name: 'Paternity Leave', quota: 10, paid: 1, doc: 1 },
    { code: 'LWP', name: 'Leave Without Pay', quota: 0, paid: 0, doc: 0 },
    { code: 'CO', name: 'Compensatory Off', quota: 0, paid: 1, doc: 0 },
  ];
  for (const type of leaveTypes) {
    await execute(
      `INSERT INTO leave_types (name, code, annual_quota, is_paid, requires_document) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), annual_quota = VALUES(annual_quota)`,
      [type.name, type.code, type.quota, type.paid, type.doc],
    );
  }

  const year = new Date().getFullYear();
  const holidays = [
    { name: 'New Year\'s Day', date: `${year}-01-01` },
    { name: 'Republic Day', date: `${year}-01-26` },
    { name: 'Holi', date: `${year}-03-04` },
    { name: 'Good Friday', date: `${year}-04-03` },
    { name: 'Independence Day', date: `${year}-08-15` },
    { name: 'Gandhi Jayanti', date: `${year}-10-02` },
    { name: 'Diwali', date: `${year}-11-08` },
    { name: 'Christmas', date: `${year}-12-25` },
    { name: 'New Year\'s Eve', date: `${year}-12-31` },
  ];
  for (const holiday of holidays) {
    await execute(
      `INSERT INTO holidays (name, holiday_date, holiday_type) VALUES (?, ?, 'public')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [holiday.name, holiday.date],
    );
  }

  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    await execute(
      `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = IF(setting_value IS NULL OR setting_value = '', VALUES(setting_value), setting_value)`,
      [key, value],
    );
  }
  await execute(
    "INSERT INTO system_settings (setting_key, setting_value) VALUES ('employee_code_seq', '1200') ON DUPLICATE KEY UPDATE setting_value = GREATEST(setting_value, '1200')",
  );
  await KpiService.ensureTemplate();
}

async function seedEmployees(): Promise<Map<string, number>> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const departments = new Map((await query<{ id: number; code: string }>('SELECT id, code FROM departments')).map((d) => [d.code, Number(d.id)]));
  const locations = new Map((await query<{ id: number; code: string }>('SELECT id, code FROM locations')).map((l) => [l.code, Number(l.id)]));
  const roles = new Map((await query<{ id: number; slug: string }>('SELECT id, slug FROM roles')).map((r) => [r.slug, Number(r.id)]));
  const designations = new Map(
    (await query<{ id: number; title: string }>('SELECT id, title FROM designations')).map((d) => [d.title, Number(d.id)]),
  );

  const ids = new Map<string, number>();
  for (const employee of EMPLOYEES) {
    const existing = await queryOne<{ id: number }>('SELECT id FROM employees WHERE employee_code = ?', [employee.code]);
    if (existing) {
      ids.set(employee.code, Number(existing.id));
      continue;
    }
    const managerId = employee.manager ? ids.get(employee.manager) ?? null : null;
    const result = await execute(
      `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, department_id, designation_id, manager_id,
        location_id, employment_type, status, joining_date, email_verified_at, mobile_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'full_time', ?, ?, NOW(3), NOW(3))`,
      [
        employee.code,
        employee.name,
        employee.email,
        employee.mobile,
        passwordHash,
        roles.get(employee.role) ?? roles.get('employee'),
        departments.get(employee.dept) ?? null,
        designations.get(employee.designation) ?? null,
        managerId,
        locations.get(employee.location) ?? null,
        employee.status ?? 'active',
        addDays(today(), -400 + ids.size * 7),
      ],
    );
    ids.set(employee.code, result.insertId);
  }

  // Department heads
  const headAssignments: [string, string][] = [
    ['EXEC', 'EMP-1002'],
    ['HR', 'EMP-1005'],
    ['IT', 'EMP-1007'],
    ['MKT', 'EMP-1012'],
    ['OPS', 'EMP-1004'],
    ['RETAIL', 'EMP-1016'],
  ];
  for (const [dept, code] of headAssignments) {
    await execute('UPDATE departments SET head_employee_id = ? WHERE code = ?', [ids.get(code) ?? null, dept]);
  }
  return ids;
}

async function seedConversations(ids: Map<string, number>): Promise<void> {
  const existing = await queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM conversations WHERE conv_type = 'channel'");
  if (Number(existing?.total ?? 0) > 0) return;

  const channels = [
    { name: 'General Announcements', description: 'Company-wide announcements', dept: null, announcement: 1, members: 'all' },
    { name: 'HR Communication', description: 'People policies and HR updates', dept: 'HR', announcement: 0, members: ['EMP-1005', 'EMP-1006', 'EMP-1001', 'EMP-1003'] },
    { name: 'IT Support', description: 'Internal IT help and coordination', dept: 'IT', announcement: 0, members: ['EMP-1007', 'EMP-1008', 'EMP-1009', 'EMP-1010', 'EMP-1011'] },
    { name: 'Operations', description: 'Day-to-day operations coordination', dept: 'OPS', announcement: 0, members: ['EMP-1004', 'EMP-1015', 'EMP-1016', 'EMP-1017', 'EMP-1018'] },
    { name: 'Marketing', description: 'Campaign and content coordination', dept: 'MKT', announcement: 0, members: ['EMP-1012', 'EMP-1013', 'EMP-1014'] },
  ];
  const departments = new Map((await query<{ id: number; code: string }>('SELECT id, code FROM departments')).map((d) => [d.code, Number(d.id)]));

  for (const channel of channels) {
    const result = await execute(
      `INSERT INTO conversations (conv_type, name, description, department_id, is_announcement, created_by)
       VALUES ('channel', ?, ?, ?, ?, ?)`,
      [channel.name, channel.description, channel.dept ? departments.get(channel.dept) ?? null : null, channel.announcement, ids.get('EMP-1001')],
    );
    const memberCodes = channel.members === 'all' ? EMPLOYEES.filter((e) => e.status !== 'pending_approval').map((e) => e.code) : channel.members;
    for (const code of memberCodes) {
      await execute("INSERT IGNORE INTO conversation_members (conversation_id, employee_id, member_role) VALUES (?, ?, 'member')", [
        result.insertId,
        ids.get(code),
      ]);
    }
    const admins = channel.members === 'all' ? ['EMP-1001', 'EMP-1005'] : memberCodes.slice(0, 1);
    for (const code of admins) {
      await execute("UPDATE conversation_members SET member_role = 'admin' WHERE conversation_id = ? AND employee_id = ?", [
        result.insertId,
        ids.get(code),
      ]);
    }
  }
}

/** Removes only demo transactional records (never employees, roles or reference data). */
async function resetDemoData(): Promise<void> {
  const tables = [
    'message_reactions',
    'message_receipts',
    'message_attachments',
    'messages',
    'project_milestones',
    'project_members',
    'task_time_logs',
    'task_attachments',
    'task_comments',
    'task_subtasks',
    'task_assignments',
    'tasks',
    'projects',
    'ticket_attachments',
    'ticket_assignments',
    'ticket_comments',
    'tickets',
    'daily_report_attachments',
    'daily_work_reports',
    'attendance_breaks',
    'attendance_corrections',
    'attendance',
    'leave_requests',
    'leave_balances',
    'meeting_action_items',
    'meeting_messages',
    'meeting_participants',
    'meetings',
    'employee_kpi_records',
    'manager_reviews',
    'notification_recipients',
    'notifications',
    'announcements',
    'conversation_members',
    'conversations',
    'files',
    'audit_logs',
    'job_runs',
  ];
  await execute('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of tables) {
    await execute(`DELETE FROM ${table}`);
  }
  await execute('SET FOREIGN_KEY_CHECKS = 1');
  console.log('[seed] demo transactional data cleared');
}

async function seedTransactionalData(ids: Map<string, number>): Promise<boolean> {
  const existing = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM tasks');
  if (Number(existing?.total ?? 0) > 0) {
    console.log('[seed] transactional data already present — skipping demo records');
    return false;
  }

  const emp = (code: string) => ids.get(code)!;
  const departments = new Map((await query<{ id: number; code: string }>('SELECT id, code FROM departments')).map((d) => [d.code, Number(d.id)]));
  const projects: Record<string, number> = {};

  const projectDefs = [
    { code: 'PRJ-001', name: 'Customer Portal Revamp', manager: 'EMP-1007', dept: 'IT', status: 'active', start: addDays(today(), -45), end: addDays(today(), 60), members: ['EMP-1009', 'EMP-1010', 'EMP-1011'] },
    { code: 'PRJ-002', name: 'Festive Campaign 2026', manager: 'EMP-1012', dept: 'MKT', status: 'active', start: addDays(today(), -20), end: addDays(today(), 30), members: ['EMP-1013', 'EMP-1014'] },
    { code: 'PRJ-003', name: 'Store Ops Standardisation', manager: 'EMP-1016', dept: 'RETAIL', status: 'planning', start: addDays(today(), -5), end: addDays(today(), 90), members: ['EMP-1017', 'EMP-1018', 'EMP-1004'] },
  ];
  for (const project of projectDefs) {
    const result = await execute(
      `INSERT INTO projects (code, name, description, manager_id, department_id, status, start_date, end_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        project.code,
        project.name,
        `${project.name} delivery programme`,
        emp(project.manager),
        departments.get(project.dept),
        project.status,
        project.start,
        project.end,
        emp(project.manager),
      ],
    );
    projects[project.code] = result.insertId;
    await execute("INSERT INTO project_members (project_id, employee_id, project_role) VALUES (?, ?, 'manager')", [result.insertId, emp(project.manager)]);
    for (const member of project.members) {
      await execute("INSERT IGNORE INTO project_members (project_id, employee_id) VALUES (?, ?)", [result.insertId, emp(member)]);
    }
    await execute('INSERT INTO project_milestones (project_id, title, due_date, status) VALUES (?, ?, ?, ?)', [
      result.insertId,
      'Discovery & requirements sign-off',
      addDays(today(), -10),
      'completed',
    ]);
    await execute('INSERT INTO project_milestones (project_id, title, due_date, status) VALUES (?, ?, ?, ?)', [
      result.insertId,
      'Delivery milestone 1',
      addDays(today(), 14),
      'open',
    ]);
  }

  const tasks = [
    { title: 'Design customer portal dashboard', assignees: ['EMP-1009'], creator: 'EMP-1007', project: 'PRJ-001', status: 'in_progress', priority: 'high', due: addDays(today(), 3), est: 960, progress: 65 },
    { title: 'Implement authentication API hardening', assignees: ['EMP-1010'], creator: 'EMP-1007', project: 'PRJ-001', status: 'pending_approval', priority: 'critical', due: addDays(today(), -1), est: 720, progress: 100 },
    { title: 'Regression suite for checkout flow', assignees: ['EMP-1011'], creator: 'EMP-1007', project: 'PRJ-001', status: 'overdue', priority: 'high', due: addDays(today(), -3), est: 480, progress: 40 },
    { title: 'Festive landing page copy', assignees: ['EMP-1013'], creator: 'EMP-1012', project: 'PRJ-002', status: 'completed', priority: 'medium', due: addDays(today(), -2), est: 360, progress: 100, approved: true },
    { title: 'Campaign creative set (5 banners)', assignees: ['EMP-1014'], creator: 'EMP-1012', project: 'PRJ-002', status: 'in_progress', priority: 'medium', due: addDays(today(), 5), est: 600, progress: 50 },
    { title: 'Weekly sales reconciliation', assignees: ['EMP-1015'], creator: 'EMP-1004', project: null, status: 'accepted', priority: 'medium', due: addDays(today(), 1), est: 180, progress: 10 },
    { title: 'Store layout audit — Pune', assignees: ['EMP-1016', 'EMP-1018'], creator: 'EMP-1004', project: 'PRJ-003', status: 'assigned', priority: 'low', due: addDays(today(), 7), est: 240, progress: 0 },
    { title: 'Billing counter training session', assignees: ['EMP-1017'], creator: 'EMP-1016', project: 'PRJ-003', status: 'in_progress', priority: 'medium', due: addDays(today(), 2), est: 120, progress: 60 },
    { title: 'Security audit follow-ups', assignees: ['EMP-1008', 'EMP-1010'], creator: 'EMP-1007', project: null, status: 'on_hold', priority: 'high', due: addDays(today(), 10), est: 480, progress: 25 },
    { title: 'Monthly MIS pack', assignees: ['EMP-1015'], creator: 'EMP-1004', project: null, status: 'completed', priority: 'high', due: addDays(today(), -5), est: 300, progress: 100, approved: true },
    { title: 'Recruitment drive — QA engineer', assignees: ['EMP-1006'], creator: 'EMP-1005', project: null, status: 'in_progress', priority: 'medium', due: addDays(today(), 6), est: 480, progress: 35 },
    { title: 'Employee handbook refresh', assignees: ['EMP-1013'], creator: 'EMP-1005', project: null, status: 'assigned', priority: 'low', due: addDays(today(), 12), est: 420, progress: 0 },
    { title: 'Quarterly server capacity review', assignees: ['EMP-1007'], creator: 'EMP-1003', project: null, status: 'completed', priority: 'high', due: addDays(today(), -12), est: 240, progress: 100, approved: true, late: true },
    { title: 'Customer complaint RCA', assignees: ['EMP-1018'], creator: 'EMP-1016', project: null, status: 'pending_approval', priority: 'high', due: addDays(today(), 0), est: 180, progress: 100 },
    { title: 'SEO keyword refresh', assignees: ['EMP-1013'], creator: 'EMP-1012', project: 'PRJ-002', status: 'assigned', priority: 'low', due: addDays(today(), 9), est: 240, progress: 0 },
  ];

  let sequence = 0;
  for (const task of tasks) {
    sequence += 1;
    const taskNo = `TSK-${String(sequence).padStart(5, '0')}`;
    const createdAt = `${addDays(today(), -Math.ceil((tasks.length - sequence) / 2))} 09:15:00`;
    const result = await execute(
      `INSERT INTO tasks (task_no, title, description, category, department_id, project_id, priority, status, created_by, manager_id,
        start_date, due_date, due_time, estimated_minutes, instructions, progress, recurrence, completed_at, approved_at, approved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '18:30:00', ?, ?, ?, 'none', ?, ?, ?)`,
      [
        taskNo,
        task.title,
        `${task.title} — please follow the agreed acceptance criteria and update progress daily.`,
        'Delivery',
        departments.get('IT'),
        task.project ? projects[task.project] : null,
        task.priority,
        task.status,
        emp(task.creator),
        emp(task.creator),
        addDays(today(), -7),
        task.due,
        task.est,
        'Coordinate with the project manager before starting. Log time against the task.',
        task.progress,
        ['completed', 'pending_approval'].includes(task.status) ? `${addDays(today(), -1)} 17:40:00` : null,
        task.approved ? `${addDays(today(), -1)} 18:10:00` : null,
        task.approved ? emp(task.creator) : null,
      ],
    );
    for (const assignee of task.assignees) {
      await execute(
        `INSERT INTO task_assignments (task_id, employee_id, assigned_by, status, accepted_at, started_at, completed_at, time_spent_minutes, completion_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          result.insertId,
          emp(assignee),
          emp(task.creator),
          task.status === 'assigned' ? 'assigned' : task.status === 'completed' ? 'completed' : task.status === 'pending_approval' ? 'pending_approval' : 'in_progress',
          `${addDays(today(), -6)} 10:05:00`,
          `${addDays(today(), -6)} 10:30:00`,
          ['completed', 'pending_approval'].includes(task.status) ? `${addDays(today(), -1)} 17:40:00` : null,
          Math.round(task.est * (task.progress / 100)),
          ['completed', 'pending_approval'].includes(task.status) ? 'Work completed and verified against acceptance criteria.' : null,
        ],
      );
    }
    if (task.progress > 20) {
      await execute('INSERT INTO task_subtasks (task_id, title, is_done, position) VALUES (?, ?, ?, 0)', [result.insertId, 'Review requirements', 1]);
      await execute('INSERT INTO task_subtasks (task_id, title, is_done, position) VALUES (?, ?, ?, 1)', [result.insertId, 'Implementation', task.progress === 100 ? 1 : 0]);
    }
    await execute('INSERT INTO task_comments (task_id, author_id, body) VALUES (?, ?, ?)', [
      result.insertId,
      emp(task.creator),
      'Please keep the status updated and flag blockers early.',
    ]);
    if (task.progress > 0) {
      await execute(
        `INSERT INTO task_time_logs (task_id, employee_id, started_at, ended_at, minutes, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          result.insertId,
          emp(task.assignees[0]),
          `${addDays(today(), -2)} 10:00:00`,
          `${addDays(today(), -2)} 13:00:00`,
          Math.min(180, Math.round(task.est * (task.progress / 100))),
          'Focused work block',
        ],
      );
    }
  }
  await execute(
    "INSERT INTO system_settings (setting_key, setting_value) VALUES ('task_no_seq', ?) ON DUPLICATE KEY UPDATE setting_value = GREATEST(setting_value, VALUES(setting_value))",
    [String(sequence)],
  );

  // ------------------------------ Attendance ------------------------------
  const activeEmployees = EMPLOYEES.filter((e) => e.status !== 'pending_approval');
  for (const [index, employee] of activeEmployees.entries()) {
    for (let dayOffset = 26; dayOffset >= 0; dayOffset -= 1) {
      const date = addDays(today(), -dayOffset);
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekday === 0) continue;
      const isToday = date === today();
      const pattern = (index + dayOffset) % 11;
      if (!isToday && pattern === 3) continue; // occasional absence
      if (isToday && index % 4 === 3) continue; // not checked in yet

      const late = pattern === 1 || pattern === 6;
      const startMinute = late ? 35 + (index % 10) : 15 + (index % 12);
      const checkIn = toSql(zonedToUtc(date, `09:${String(startMinute).padStart(2, '0')}:00`));
      const endMinute = 25 + (index % 20);
      const checkOut = isToday ? null : toSql(zonedToUtc(date, `18:${String(Math.min(59, endMinute)).padStart(2, '0')}:00`));
      const breakMinutes = isToday ? 0 : 35 + (index % 15);
      const totalMinutes = isToday ? 0 : 9 * 60 - (late ? 20 : 0) - breakMinutes;

      await execute(
        `INSERT INTO attendance (employee_id, work_date, check_in_at, check_out_at, status, total_minutes, break_minutes, overtime_minutes, is_late, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed')
         ON DUPLICATE KEY UPDATE check_in_at = VALUES(check_in_at), check_out_at = VALUES(check_out_at),
           status = VALUES(status), total_minutes = VALUES(total_minutes), break_minutes = VALUES(break_minutes), is_late = VALUES(is_late)`,
        [
          emp(employee.code),
          date,
          checkIn,
          checkOut,
          late ? 'late' : 'present',
          totalMinutes,
          breakMinutes,
          Math.max(0, totalMinutes - 9 * 60),
          late ? 1 : 0,
        ],
      );

      if (!isToday) {
        const attendanceRow = await queryOne<{ id: number }>('SELECT id FROM attendance WHERE employee_id = ? AND work_date = ?', [
          emp(employee.code),
          date,
        ]);
        if (attendanceRow) {
          await execute('INSERT INTO attendance_breaks (attendance_id, employee_id, started_at, ended_at, minutes) VALUES (?, ?, ?, ?, ?)', [
            attendanceRow.id,
            emp(employee.code),
            toSql(zonedToUtc(date, '13:30:00')),
            toSql(zonedToUtc(date, '14:15:00')),
            breakMinutes,
          ]);
        }
      }
    }
  }

  // ---------------------------- Daily reports -----------------------------
  for (const [index, employee] of activeEmployees.slice(2, 14).entries()) {
    for (const offset of [5, 4, 3, 2, 1]) {
      const date = addDays(today(), -offset);
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekday === 0) continue;
      const status = (index + offset) % 5 === 0 ? 'changes_requested' : offset > 2 ? 'approved' : 'submitted';
      await execute(
        `INSERT INTO daily_work_reports (employee_id, report_date, work_start, work_end, total_minutes, summary, problems, support_required,
          tomorrow_plan, tasks_completed, tasks_in_progress, tasks_pending, status, submitted_at, reviewed_by, reviewed_at, review_note)
         VALUES (?, ?, '09:30:00', '18:30:00', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE summary = VALUES(summary)`,
        [
          emp(employee.code),
          date,
          510,
          `Completed planned work on ${index % 2 === 0 ? 'project deliverables' : 'operational tasks'} and coordinated with the team on pending items.`,
          index % 4 === 0 ? 'Dependency on external vendor response delayed one item.' : null,
          index % 5 === 0 ? 'Need design approval to proceed with the next milestone.' : null,
          'Continue with the in-progress items and close the open review comments.',
          3,
          2,
          1,
          status,
          `${date} 18:40:00`,
          ['approved', 'changes_requested'].includes(status) ? emp(EMPLOYEES[6].code) : null,
          ['approved', 'changes_requested'].includes(status) ? `${date} 19:05:00` : null,
          status === 'changes_requested' ? 'Please add more detail around the pending dependency.' : 'Approved. Good progress.',
        ],
      );
    }
  }

  // ------------------------------- Tickets --------------------------------
  const tickets = [
    { subject: 'Laptop not booting after update', category: 'Hardware Issues', priority: 'high', status: 'in_progress', requester: 'EMP-1013', assignee: 'EMP-1008', team: 'IT Support' },
    { subject: 'Unable to access attendance portal', category: 'Attendance Issues', priority: 'critical', status: 'resolved', requester: 'EMP-1017', assignee: 'EMP-1008', team: 'HR' },
    { subject: 'Store POS printer offline', category: 'Store Operations', priority: 'high', status: 'assigned', requester: 'EMP-1018', assignee: 'EMP-1008', team: 'Operations' },
    { subject: 'Payroll deduction mismatch', category: 'Payroll Issues', priority: 'medium', status: 'waiting_information', requester: 'EMP-1015', assignee: 'EMP-1006', team: 'HR' },
    { subject: 'VPN disconnects repeatedly', category: 'Network Issues', priority: 'medium', status: 'acknowledged', requester: 'EMP-1014', assignee: 'EMP-1008', team: 'IT Support' },
    { subject: 'Customer escalation on delivery delay', category: 'Customer Complaints', priority: 'critical', status: 'in_progress', requester: 'EMP-1016', assignee: 'EMP-1018', team: 'Customer Success' },
    { subject: 'Access to analytics dashboard', category: 'Software Issues', priority: 'low', status: 'closed', requester: 'EMP-1004', assignee: 'EMP-1008', team: 'IT Support' },
    { subject: 'Office chair replacement', category: 'Infrastructure Issues', priority: 'low', status: 'new', requester: 'EMP-1013', assignee: null, team: 'Facilities' },
  ];
  let ticketSeq = 0;
  for (const ticket of tickets) {
    ticketSeq += 1;
    const createdAt = `${addDays(today(), -((ticketSeq % 6) + 1))} 11:20:00`;
    const result = await execute(
      `INSERT INTO tickets (ticket_no, subject, description, category, priority, status, department_id, requester_id, assigned_team, assignee_id,
        sla_due_at, acknowledged_at, resolved_at, closed_at, resolution, feedback_rating)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `TKT-${String(ticketSeq).padStart(5, '0')}`,
        ticket.subject,
        `${ticket.subject}. Detailed description captured for resolution tracking.`,
        ticket.category,
        ticket.priority,
        ticket.status,
        departments.get(ticket.category.includes('Payroll') || ticket.category.includes('Attendance') ? 'HR' : ticket.category.includes('Store') || ticket.category.includes('Customer') ? 'OPS' : 'IT'),
        emp(ticket.requester),
        ticket.team,
        ticket.assignee ? emp(ticket.assignee) : null,
        `${addDays(today(), 2)} 18:00:00`,
        ['acknowledged', 'in_progress', 'waiting_information', 'resolved', 'closed'].includes(ticket.status) ? createdAt : null,
        ['resolved', 'closed'].includes(ticket.status) ? `${addDays(today(), -1)} 15:10:00` : null,
        ticket.status === 'closed' ? `${addDays(today(), -1)} 16:00:00` : null,
        ['resolved', 'closed'].includes(ticket.status) ? 'Issue reproduced, fix applied and verified with the requester.' : null,
        ticket.status === 'closed' ? 5 : null,
      ],
    );
    await execute('INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal) VALUES (?, ?, ?, 0)', [
      result.insertId,
      emp(ticket.requester),
      'Adding context: the issue is reproducible on my primary device.',
    ]);
    if (ticket.assignee) {
      await execute('INSERT INTO ticket_assignments (ticket_id, employee_id, assigned_by, note) VALUES (?, ?, ?, ?)', [
        result.insertId,
        emp(ticket.assignee),
        emp('EMP-1008'),
        'Auto-routed by category',
      ]);
      await execute('INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal) VALUES (?, ?, ?, 1)', [
        result.insertId,
        emp(ticket.assignee),
        'Internal note: checked asset register, replacement approved if repair fails.',
      ]);
    }
  }
  await execute(
    "INSERT INTO system_settings (setting_key, setting_value) VALUES ('ticket_no_seq', ?) ON DUPLICATE KEY UPDATE setting_value = GREATEST(setting_value, VALUES(setting_value))",
    [String(ticketSeq)],
  );

  // --------------------------- Direct messages ----------------------------
  const general = await queryOne<{ id: number }>("SELECT id FROM conversations WHERE name = 'General Announcements' LIMIT 1");
  const itSupport = await queryOne<{ id: number }>("SELECT id FROM conversations WHERE name = 'IT Support' LIMIT 1");
  if (general) {
    await execute(
      `INSERT INTO messages (conversation_id, sender_id, body, message_type, created_at) VALUES (?, ?, ?, 'text', ?)`,
      [
        general.id,
        emp('EMP-1001'),
        'Welcome to the Workforce platform. Please complete your profile and submit daily reports before 7 PM.',
        `${addDays(today(), -1)} 09:05:00`,
      ],
    );
  }
  if (itSupport) {
    await execute('INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)', [
      itSupport.id,
      emp('EMP-1008'),
      'Reminder: scheduled network maintenance tonight between 10 PM and 11 PM.',
      `${addDays(today(), -1)} 16:30:00`,
    ]);
  }

  const directPairs: [string, string, [string, string][]][] = [
    ['EMP-1009', 'EMP-1007', [['EMP-1007', 'Can you share the updated dashboard designs today?'], ['EMP-1009', 'Yes, I will post the link by 3 PM.'], ['EMP-1007', 'Perfect. Please also add the empty states we discussed.']]],
    ['EMP-1013', 'EMP-1012', [['EMP-1012', 'Campaign copy needs one more revision for the festive banner.'], ['EMP-1013', 'On it — sharing the revised draft in an hour.']]],
    ['EMP-1016', 'EMP-1004', [['EMP-1016', 'Pune store audit scheduled for tomorrow morning.'], ['EMP-1004', 'Good. Include the stock reconciliation findings.']]],
  ];
  for (const [a, b, conversation] of directPairs) {
    const result = await execute("INSERT INTO conversations (conv_type, created_by) VALUES ('direct', ?)", [emp(a)]);
    await execute('INSERT INTO conversation_members (conversation_id, employee_id) VALUES (?, ?), (?, ?)', [result.insertId, emp(a), result.insertId, emp(b)]);
    let offset = 3;
    for (const [sender, body] of conversation) {
      const message = await execute('INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)', [
        result.insertId,
        emp(sender),
        body,
        `${addDays(today(), -1)} ${String(9 + offset).padStart(2, '0')}:15:00`,
      ]);
      await execute('INSERT INTO message_receipts (message_id, employee_id, delivered_at, read_at) VALUES (?, ?, NOW(3), NOW(3))', [
        message.insertId,
        emp(a === sender ? b : a),
      ]);
      offset += 1;
    }
    await execute('UPDATE conversation_members SET last_read_at = NOW(3) WHERE conversation_id = ? AND employee_id = ?', [result.insertId, emp(b)]);
  }

  // ------------------------------- Meetings -------------------------------
  const meetingDefs = [
    {
      title: 'Daily delivery stand-up',
      organizer: 'EMP-1007',
      participants: ['EMP-1008', 'EMP-1009', 'EMP-1010', 'EMP-1011'],
      start: `${today()} 10:00:00`,
      end: `${today()} 10:30:00`,
      status: 'completed',
      outcome: 'Reviewed sprint progress. API hardening is ready for approval; regression suite needs one more day.',
    },
    {
      title: 'Campaign review — festive launch',
      organizer: 'EMP-1012',
      participants: ['EMP-1013', 'EMP-1014', 'EMP-1003'],
      start: `${today()} 15:00:00`,
      end: `${today()} 15:45:00`,
      status: 'scheduled',
      outcome: null,
    },
    {
      title: 'Monthly performance review',
      organizer: 'EMP-1003',
      participants: ['EMP-1004', 'EMP-1005', 'EMP-1007', 'EMP-1012', 'EMP-1016'],
      start: `${addDays(today(), 2)} 11:00:00`,
      end: `${addDays(today(), 2)} 12:00:00`,
      status: 'scheduled',
      outcome: null,
    },
  ];
  for (const meeting of meetingDefs) {
    const code = crypto.randomUUID();
    const result = await execute(
      `INSERT INTO meetings (title, description, agenda, organizer_id, department_id, location_type, start_at, end_at, meeting_code, status, outcome)
       VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?)`,
      [
        meeting.title,
        `${meeting.title} — internal meeting`,
        '1. Progress review\n2. Blockers\n3. Next actions',
        emp(meeting.organizer),
        departments.get('EXEC'),
        meeting.start,
        meeting.end,
        code,
        meeting.status,
        meeting.outcome,
      ],
    );
    await execute("INSERT INTO meeting_participants (meeting_id, employee_id, response, attended) VALUES (?, ?, 'accepted', ?)", [
      result.insertId,
      emp(meeting.organizer),
      meeting.status === 'completed' ? 1 : 0,
    ]);
    for (const participant of meeting.participants) {
      await execute("INSERT INTO meeting_participants (meeting_id, employee_id, response) VALUES (?, ?, 'accepted')", [result.insertId, emp(participant)]);
    }
    if (meeting.status === 'completed') {
      await execute('INSERT INTO meeting_action_items (meeting_id, title, assignee_id, due_date) VALUES (?, ?, ?, ?)', [
        result.insertId,
        'Complete regression suite and share results',
        emp('EMP-1011'),
        addDays(today(), 1),
      ]);
      await execute('INSERT INTO meeting_action_items (meeting_id, title, assignee_id, due_date, status, completed_at) VALUES (?, ?, ?, ?, ?, NOW(3))', [
        result.insertId,
        'Submit API hardening for approval',
        emp('EMP-1010'),
        today(),
        'done',
      ]);
    }
  }

  // -------------------------------- Leave ---------------------------------
  const leaveTypes = new Map((await query<{ id: number; code: string }>('SELECT id, code FROM leave_types')).map((t) => [t.code, Number(t.id)]));
  const leaves = [
    { employee: 'EMP-1009', type: 'CL', start: addDays(today(), 3), end: addDays(today(), 4), status: 'pending_manager', reason: 'Family function out of town, requesting two days of casual leave.' },
    { employee: 'EMP-1013', type: 'SL', start: addDays(today(), -2), end: addDays(today(), -2), status: 'approved', reason: 'Viral fever, doctor advised rest for one day.' },
    { employee: 'EMP-1017', type: 'CL', start: addDays(today(), 7), end: addDays(today(), 8), status: 'pending_hr', reason: 'Personal work requiring travel to hometown.' },
    { employee: 'EMP-1018', type: 'EL', start: addDays(today(), -20), end: addDays(today(), -18), status: 'approved', reason: 'Annual family vacation planned months in advance.' },
  ];
  for (const leave of leaves) {
    const days = Math.round((new Date(leave.end).getTime() - new Date(leave.start).getTime()) / 86400000) + 1;
    const manager = EMPLOYEES.find((e) => e.code === leave.employee)?.manager;
    const result = await execute(
      `INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status, manager_id, manager_action_at, hr_action_at, decision_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        emp(leave.employee),
        leaveTypes.get(leave.type),
        leave.start,
        leave.end,
        days,
        leave.reason,
        leave.status,
        manager ? emp(manager) : null,
        leave.status === 'pending_manager' ? null : `${addDays(today(), -1)} 12:00:00`,
        leave.status === 'approved' ? `${addDays(today(), -1)} 13:00:00` : null,
        leave.status === 'approved' ? 'Approved, please hand over pending work.' : null,
      ],
    );
    if (leave.status === 'approved') {
      for (let i = 0; i < days; i += 1) {
        await execute(
          `INSERT INTO attendance (employee_id, work_date, status, notes) VALUES (?, ?, 'on_leave', 'Approved leave')
           ON DUPLICATE KEY UPDATE status = IF(check_in_at IS NULL, 'on_leave', status)`,
          [emp(leave.employee), addDays(leave.start, i)],
        );
      }
      void result;
    }
  }

  // ---------------------------- Announcements -----------------------------
  const announcement = await execute(
    `INSERT INTO announcements (title, body, priority, created_by, audience_type) VALUES (?, ?, 'high', ?, 'all')`,
    ['Quarterly town hall next Friday', 'All employees are invited to the quarterly town hall at 4 PM in the Mumbai HQ auditorium. Remote colleagues can join online.', emp('EMP-1001')],
  );
  for (const employee of activeEmployees) {
    const notification = await execute(
      `INSERT IGNORE INTO notifications (notif_type, title, body, link, priority, actor_id, announcement_id)
       VALUES ('announcement', ?, ?, '/notifications', 'high', ?, ?)`,
      ['Quarterly town hall next Friday', 'Join us at 4 PM next Friday for the quarterly town hall.', emp('EMP-1001'), announcement.insertId],
    );
    if (notification.insertId) {
      await execute('INSERT IGNORE INTO notification_recipients (notification_id, employee_id) VALUES (?, ?)', [notification.insertId, emp(employee.code)]);
    }
  }

  // --------------------------------- KPI ----------------------------------
  const previousPeriod = periodOf(addMonths(today(), -1));
  const templateId = await KpiService.ensureTemplate();
  for (const employee of activeEmployees) {
    const metrics = await KpiService.computeMetrics(emp(employee.code), previousPeriod);
    await execute(
      `INSERT INTO employee_kpi_records (employee_id, template_id, period, scores, metrics, total_score, category, status, manager_comment,
        strengths, improvements, published_at, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, NOW(3), ?, NOW(3))
       ON DUPLICATE KEY UPDATE total_score = VALUES(total_score), scores = VALUES(scores), metrics = VALUES(metrics)`,
      [
        emp(employee.code),
        templateId,
        previousPeriod,
        JSON.stringify(metrics.scores),
        JSON.stringify({ ...metrics.metrics, workingDays: metrics.workingDays, excluded: metrics.excluded }),
        metrics.total,
        metrics.category,
        'Consistent contribution. Continue focus on timely delivery and documentation.',
        'Reliable collaborator, good ownership of assigned work.',
        'Strengthen proactive status updates and reduce rework.',
        emp(employee.manager ?? employee.code),
      ],
    );
  }

  return true;
}

/**
 * Boot-time seeding. Reference data is always safe to upsert. Demo employees
 * (with the published demo password) are created only outside production; a
 * production installation gets exactly one administrator from
 * BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, who must change the password.
 */
export async function seedBasicData(): Promise<void> {
  console.log('[seed] Seeding reference data (roles, permissions, departments, etc.)...');
  await seedReferenceData();
  if (!config.isProd) {
    console.log('[seed] Seeding development employee accounts (EMP-1001, etc.)...');
    await seedEmployees();
    return;
  }
  await seedBootstrapAdmin();
}

async function seedBootstrapAdmin(): Promise<void> {
  const existing = await queryOne<{ cnt: number | string }>('SELECT COUNT(*) AS cnt FROM employees');
  if (Number(existing?.cnt ?? 0) > 0) return;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password === DEMO_PASSWORD) {
    console.warn('[seed] No employees exist. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (12+ chars) or complete the website setup to create the first administrator. No default accounts were created.');
    return;
  }
  const role = await queryOne<{ id: number }>("SELECT id FROM roles WHERE slug = 'super_admin'");
  if (!role) throw new Error('super_admin role missing after reference seeding');
  await execute(
    `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, employment_type, status, joining_date,
                            email_verified_at, must_change_password)
     VALUES ('EMP-1001', ?, ?, ?, ?, ?, 'full_time', 'active', ?, NOW(3), 1)`,
    [process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Administrator', email, process.env.BOOTSTRAP_ADMIN_MOBILE?.trim() || '0000000000', await hashPassword(password), role.id, today()],
  );
  console.log(`[seed] Bootstrap administrator created for ${email}. Remove BOOTSTRAP_ADMIN_PASSWORD from the environment now.`);
}

/** Production safety check: reports active accounts that still use the published demo password. */
export async function findDemoPasswordAccounts(): Promise<string[]> {
  const { verifyPassword } = await import('../lib/crypto.js');
  const rows = await query<{ email: string; password_hash: string }>(
    "SELECT email, password_hash FROM employees WHERE status = 'active' AND email LIKE '%@workforce.test'",
  );
  const matches: string[] = [];
  for (const row of rows) if (await verifyPassword(DEMO_PASSWORD, row.password_hash)) matches.push(row.email);
  return matches;
}

async function main(): Promise<void> {
  if (config.isProd || !process.argv.includes('--demo')) throw new Error('Sample data is disabled. Use the website setup for live data. Explicit --demo is required on a disposable development database.');
  const started = Date.now();
  console.log('[seed] running migrations');
  await runMigrations();
  console.log('[seed] reference data');
  await seedReferenceData();
  console.log('[seed] employees');
  const ids = await seedEmployees();
  if (process.argv.includes('--reset')) {
    await resetDemoData();
  }
  console.log('[seed] conversation channels');
  await seedConversations(ids);
  console.log('[seed] transactional demo data');
  const created = await seedTransactionalData(ids);

  const counts = await query<{ employees: number; tasks: number; attendance: number; messages: number; tickets: number }>(
    `SELECT (SELECT COUNT(*) FROM employees) AS employees, (SELECT COUNT(*) FROM tasks) AS tasks,
            (SELECT COUNT(*) FROM attendance) AS attendance, (SELECT COUNT(*) FROM messages) AS messages,
            (SELECT COUNT(*) FROM tickets) AS tickets`,
  );
  console.log(`[seed] done in ${Date.now() - started}ms`, counts[0]);
  if (created) {
    console.log('\n  Demo accounts (password: Workforce@2026)\n');
    console.log('  Super Admin      admin@workforce.test        (EMP-1001 Aarti Sharma)');
    console.log('  Executive        coo@workforce.test          (EMP-1003 Priya Nair)');
    console.log('  HR Manager       hr.manager@workforce.test   (EMP-1005 Neha Kapoor)');
    console.log('  IT Manager       it.manager@workforce.test   (EMP-1007 Arjun Patel)');
    console.log('  IT Admin         it.admin@workforce.test     (EMP-1008 Rohan Gupta)');
    console.log('  Store Manager    store.manager@workforce.test (EMP-1016 Farhan Khan)');
    console.log('  Employee         ananya.rao@workforce.test   (EMP-1009 Ananya Rao)\n');
  }
  await pool.end();
}

const isDirectRun = process.argv[1] && (
  process.argv[1].replace(/\\/g, '/').endsWith('db/seed.ts') ||
  process.argv[1].replace(/\\/g, '/').endsWith('db/seed.js')
);

if (isDirectRun) {
  main().catch(async (error) => {
    console.error('[seed] failed', error);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
}

