const mysql = require('mysql2/promise');
const { config } = require('../backend/dist/config.js');
const { hashPassword } = require('../backend/dist/lib/crypto.js');

async function main() {
  const conn = await mysql.createConnection(config.db);
  console.log('Connected to database...');

  // 1. Ensure Retail Operations and OPS departments exist
  const [depts] = await conn.query('SELECT id, code FROM departments');
  const deptMap = new Map(depts.map(d => [d.code, Number(d.id)]));
  const retailDeptId = deptMap.get('RETAIL') || 6;
  const opsDeptId = deptMap.get('OPS') || 5;

  // 2. Ensure all 11 retail designations exist
  const designationsToEnsure = [
    { title: 'Store Manager', level: 14, code: 'RETAIL-STORE-MANAGER', deptId: retailDeptId },
    { title: 'Assistant Store Manager', level: 12, code: 'RETAIL-ASSISTANT-STORE-MANAGER', deptId: retailDeptId },
    { title: 'Floor Manager', level: 11, code: 'RETAIL-FLOOR-MANAGER', deptId: retailDeptId },
    { title: 'Section Supervisor', level: 10, code: 'RETAIL-SEC-SUP', deptId: retailDeptId },
    { title: 'Billing Supervisor', level: 10, code: 'RETAIL-BILL-SUP', deptId: retailDeptId },
    { title: 'Cashier Supervisor', level: 10, code: 'RETAIL-CASH-SUP', deptId: retailDeptId },
    { title: 'Cashier', level: 3, code: 'RETAIL-CASHIER', deptId: retailDeptId },
    { title: 'CRM Manager', level: 13, code: 'OPS-CRM-MANAGER', deptId: opsDeptId },
    { title: 'CRM Executive', level: 7, code: 'OPS-CRM-EXECUTIVE', deptId: opsDeptId },
    { title: 'Warehouse Manager', level: 13, code: 'RETAIL-WH-MGR', deptId: retailDeptId },
    { title: 'Warehouse Staff', level: 4, code: 'RETAIL-WH-STF', deptId: retailDeptId },
  ];

  for (const d of designationsToEnsure) {
    await conn.query(
      `INSERT INTO designations (title, department_id, level, code)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE level = VALUES(level), department_id = VALUES(department_id)`,
      [d.title, d.deptId, d.level, d.code]
    );
  }
  console.log('Designations verified.');

  const [allDesigs] = await conn.query('SELECT id, title FROM designations');
  const desigMap = new Map(allDesigs.map(d => [d.title, Number(d.id)]));

  // 3. Ensure Roles exist
  const [allRoles] = await conn.query('SELECT id, slug FROM roles');
  const roleMap = new Map(allRoles.map(r => [r.slug, Number(r.id)]));
  const storeMgrRoleId = roleMap.get('store_manager') || roleMap.get('manager') || 11;
  const mgrRoleId = roleMap.get('manager') || 6;
  const teamLeadRoleId = roleMap.get('team_leader') || 16;
  const empRoleId = roleMap.get('employee') || 13;

  // 4. Locations: DAV, SHI, BEL
  const [allLocs] = await conn.query('SELECT id, code FROM locations');
  const locMap = new Map(allLocs.map(l => [l.code, Number(l.id)]));

  const validPasswordHash = await hashPassword('Workforce@2026');

  // Master Store Employees Definition
  const storeStaff = [
    // Davanagere (DAV)
    { loc: 'DAV', code: 'EMP-DAV-001', name: 'Ramesh Patil', email: 'ramesh.patil@bsctextiles.in', phone: '9845011001', desig: 'Store Manager', roleId: storeMgrRoleId, reportsToCode: null },
    { loc: 'DAV', code: 'EMP-DAV-002', name: 'Suresh Kumar', email: 'suresh.kumar@bsctextiles.in', phone: '9845011002', desig: 'Assistant Store Manager', roleId: mgrRoleId, reportsToCode: 'EMP-DAV-001' },
    { loc: 'DAV', code: 'EMP-DAV-003', name: 'Manjunath B', email: 'manjunath.b@bsctextiles.in', phone: '9845011003', desig: 'Floor Manager', roleId: mgrRoleId, reportsToCode: 'EMP-DAV-002' },
    { loc: 'DAV', code: 'EMP-DAV-004', name: 'Venkatesh N', email: 'venkatesh.n@bsctextiles.in', phone: '9845011004', desig: 'Section Supervisor', roleId: teamLeadRoleId, reportsToCode: 'EMP-DAV-003' },
    { loc: 'DAV', code: 'EMP-DAV-005', name: 'Rajesh Gowda', email: 'rajesh.gowda@bsctextiles.in', phone: '9845011005', desig: 'Billing Supervisor', roleId: teamLeadRoleId, reportsToCode: 'EMP-DAV-001' },
    { loc: 'DAV', code: 'EMP-DAV-006', name: 'Anand Rao', email: 'anand.rao@bsctextiles.in', phone: '9845011006', desig: 'Cashier Supervisor', roleId: teamLeadRoleId, reportsToCode: 'EMP-DAV-001' },
    { loc: 'DAV', code: 'EMP-DAV-007', name: 'Praveen K', email: 'praveen.k@bsctextiles.in', phone: '9845011007', desig: 'Cashier', roleId: empRoleId, reportsToCode: 'EMP-DAV-006' },
    { loc: 'DAV', code: 'EMP-DAV-008', name: 'Sneha Hegde', email: 'sneha.hegde@bsctextiles.in', phone: '9845011008', desig: 'CRM Manager', roleId: mgrRoleId, reportsToCode: 'EMP-DAV-001' },
    { loc: 'DAV', code: 'EMP-DAV-009', name: 'Deepa K', email: 'deepa.k@bsctextiles.in', phone: '9845011009', desig: 'CRM Executive', roleId: empRoleId, reportsToCode: 'EMP-DAV-008' },
    { loc: 'DAV', code: 'EMP-DAV-010', name: 'Raghavendra T', email: 'raghavendra.t@bsctextiles.in', phone: '9845011010', desig: 'Warehouse Manager', roleId: mgrRoleId, reportsToCode: 'EMP-DAV-001' },
    { loc: 'DAV', code: 'EMP-DAV-011', name: 'Naveen S', email: 'naveen.s@bsctextiles.in', phone: '9845011011', desig: 'Warehouse Staff', roleId: empRoleId, reportsToCode: 'EMP-DAV-010' },

    // Shivamogga (SHI)
    { loc: 'SHI', code: 'EMP-SHI-001', name: 'Kiran Joshi', email: 'kiran.joshi@bsctextiles.in', phone: '9845022001', desig: 'Store Manager', roleId: storeMgrRoleId, reportsToCode: null },
    { loc: 'SHI', code: 'EMP-SHI-002', name: 'Harish Naik', email: 'harish.naik@bsctextiles.in', phone: '9845022002', desig: 'Assistant Store Manager', roleId: mgrRoleId, reportsToCode: 'EMP-SHI-001' },
    { loc: 'SHI', code: 'EMP-SHI-003', name: 'Santosh Bhat', email: 'santosh.bhat@bsctextiles.in', phone: '9845022003', desig: 'Floor Manager', roleId: mgrRoleId, reportsToCode: 'EMP-SHI-002' },
    { loc: 'SHI', code: 'EMP-SHI-004', name: 'Mallikarjun M', email: 'mallikarjun.m@bsctextiles.in', phone: '9845022004', desig: 'Section Supervisor', roleId: teamLeadRoleId, reportsToCode: 'EMP-SHI-003' },
    { loc: 'SHI', code: 'EMP-SHI-005', name: 'Vinay Kumar', email: 'vinay.kumar@bsctextiles.in', phone: '9845022005', desig: 'Billing Supervisor', roleId: teamLeadRoleId, reportsToCode: 'EMP-SHI-001' },
    { loc: 'SHI', code: 'EMP-SHI-006', name: 'Prashanth D', email: 'prashanth.d@bsctextiles.in', phone: '9845022006', desig: 'Cashier Supervisor', roleId: teamLeadRoleId, reportsToCode: 'EMP-SHI-001' },
    { loc: 'SHI', code: 'EMP-SHI-007', name: 'Mohan Rao', email: 'mohan.rao@bsctextiles.in', phone: '9845022007', desig: 'Cashier', roleId: empRoleId, reportsToCode: 'EMP-SHI-006' },
    { loc: 'SHI', code: 'EMP-SHI-008', name: 'Pooja Sharma', email: 'pooja.sharma@bsctextiles.in', phone: '9845022008', desig: 'CRM Manager', roleId: mgrRoleId, reportsToCode: 'EMP-SHI-001' },
    { loc: 'SHI', code: 'EMP-SHI-009', name: 'Priya M', email: 'priya.m@bsctextiles.in', phone: '9845022009', desig: 'CRM Executive', roleId: empRoleId, reportsToCode: 'EMP-SHI-008' },
    { loc: 'SHI', code: 'EMP-SHI-010', name: 'Basavaraj K', email: 'basavaraj.k@bsctextiles.in', phone: '9845022010', desig: 'Warehouse Manager', roleId: mgrRoleId, reportsToCode: 'EMP-SHI-001' },
    { loc: 'SHI', code: 'EMP-SHI-011', name: 'Manjunath K', email: 'manjunath.k@bsctextiles.in', phone: '9845022011', desig: 'Warehouse Staff', roleId: empRoleId, reportsToCode: 'EMP-SHI-010' },

    // Belagavi (BEL)
    { loc: 'BEL', code: 'EMP-BEL-001', name: 'Shivanand Kulkarni', email: 'shivanand.kulkarni@bsctextiles.in', phone: '9845033001', desig: 'Store Manager', roleId: storeMgrRoleId, reportsToCode: null },
    { loc: 'BEL', code: 'EMP-BEL-002', name: 'Sachin Desai', email: 'sachin.desai@bsctextiles.in', phone: '9845033002', desig: 'Assistant Store Manager', roleId: mgrRoleId, reportsToCode: 'EMP-BEL-001' },
    { loc: 'BEL', code: 'EMP-BEL-003', name: 'Ganesh Patil', email: 'ganesh.patil@bsctextiles.in', phone: '9845033003', desig: 'Floor Manager', roleId: mgrRoleId, reportsToCode: 'EMP-BEL-002' },
    { loc: 'BEL', code: 'EMP-BEL-004', name: 'Vijay Shinde', email: 'vijay.shinde@bsctextiles.in', phone: '9845033004', desig: 'Section Supervisor', roleId: teamLeadRoleId, reportsToCode: 'EMP-BEL-003' },
    { loc: 'BEL', code: 'EMP-BEL-005', name: 'Nitin Jadhav', email: 'nitin.jadhav@bsctextiles.in', phone: '9845033005', desig: 'Billing Supervisor', roleId: teamLeadRoleId, reportsToCode: 'EMP-BEL-001' },
    { loc: 'BEL', code: 'EMP-BEL-006', name: 'Chetan More', email: 'chetan.more@bsctextiles.in', phone: '9845033006', desig: 'Cashier Supervisor', roleId: teamLeadRoleId, reportsToCode: 'EMP-BEL-001' },
    { loc: 'BEL', code: 'EMP-BEL-007', name: 'Rahul Chavan', email: 'rahul.chavan@bsctextiles.in', phone: '9845033007', desig: 'Cashier', roleId: empRoleId, reportsToCode: 'EMP-BEL-006' },
    { loc: 'BEL', code: 'EMP-BEL-008', name: 'Kavita Kadam', email: 'kavita.kadam@bsctextiles.in', phone: '9845033008', desig: 'CRM Manager', roleId: mgrRoleId, reportsToCode: 'EMP-BEL-001' },
    { loc: 'BEL', code: 'EMP-BEL-009', name: 'Anjali Pawar', email: 'anjali.pawar@bsctextiles.in', phone: '9845033009', desig: 'CRM Executive', roleId: empRoleId, reportsToCode: 'EMP-BEL-008' },
    { loc: 'BEL', code: 'EMP-BEL-010', name: 'Prakash Gaikwad', email: 'prakash.gaikwad@bsctextiles.in', phone: '9845033010', desig: 'Warehouse Manager', roleId: mgrRoleId, reportsToCode: 'EMP-BEL-001' },
    { loc: 'BEL', code: 'EMP-BEL-011', name: 'Rohit Mane', email: 'rohit.mane@bsctextiles.in', phone: '9845033011', desig: 'Warehouse Staff', roleId: empRoleId, reportsToCode: 'EMP-BEL-010' },
  ];

  // Insert or update employees
  for (const s of storeStaff) {
    const locId = locMap.get(s.loc);
    const desigId = desigMap.get(s.desig);
    const deptId = (s.desig.includes('CRM') ? opsDeptId : retailDeptId);

    await conn.query(
      `INSERT INTO employees (employee_code, full_name, email, mobile, password_hash, role_id, department_id, designation_id, location_id, status, joining_date, email_verified_at, mobile_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURDATE(), NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE 
         full_name = VALUES(full_name),
         role_id = VALUES(role_id),
         department_id = VALUES(department_id),
         designation_id = VALUES(designation_id),
         location_id = VALUES(location_id),
         status = 'active'`,
      [s.code, s.name, s.email, s.phone, validPasswordHash, s.roleId, deptId, desigId, locId]
    );
  }

  // Update manager hierarchy
  const [empRows] = await conn.query('SELECT id, employee_code FROM employees');
  const empCodeToId = new Map(empRows.map(e => [e.employee_code, Number(e.id)]));
  const superAdminId = empCodeToId.get('EMP-1001') || 1;

  for (const s of storeStaff) {
    const empId = empCodeToId.get(s.code);
    const managerId = s.reportsToCode ? empCodeToId.get(s.reportsToCode) : superAdminId;
    if (empId) {
      await conn.query('UPDATE employees SET manager_id = ? WHERE id = ?', [managerId, empId]);
    }
  }

  console.log(`Seeded ${storeStaff.length} store hierarchy employees successfully.`);
  await conn.end();
}

main().catch(console.error);
