-- ---------------------------------------------------------------------------
-- Workforce Management Platform :: initial relational schema
-- Engine: MySQL 8.0+ / InnoDB / utf8mb4
-- All DATETIME values are stored in UTC. Business dates (work_date, report_date)
-- are derived in the organisation timezone by the application layer.
-- ---------------------------------------------------------------------------
SET NAMES utf8mb4;

-- ------------------------- Organisation structure -------------------------
CREATE TABLE IF NOT EXISTS departments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(24) NOT NULL,
  parent_id BIGINT UNSIGNED NULL,
  head_employee_id BIGINT UNSIGNED NULL,
  description VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_departments_code (code),
  KEY idx_departments_parent (parent_id),
  CONSTRAINT fk_departments_parent FOREIGN KEY (parent_id) REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS designations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(120) NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  level SMALLINT NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_designations_title_dept (title, department_id),
  KEY idx_designations_department (department_id),
  CONSTRAINT fk_designations_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS locations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(24) NOT NULL,
  address VARCHAR(255) NULL,
  city VARCHAR(80) NULL,
  state VARCHAR(80) NULL,
  country VARCHAR(80) NULL DEFAULT 'India',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  latitude DECIMAL(10, 7) NULL,
  longitude DECIMAL(10, 7) NULL,
  geofence_radius_m INT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_locations_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------ RBAC --------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(80) NOT NULL,
  category VARCHAR(64) NOT NULL DEFAULT 'general',
  level SMALLINT NOT NULL DEFAULT 10,
  description VARCHAR(255) NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(96) NOT NULL,
  module VARCHAR(48) NOT NULL,
  action VARCHAR(48) NOT NULL,
  description VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_permissions_code (code),
  KEY idx_permissions_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (role_id, permission_id),
  KEY idx_role_permissions_permission (permission_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------- Employees -----------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_code VARCHAR(24) NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  email VARCHAR(190) NOT NULL,
  mobile VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  designation_id BIGINT UNSIGNED NULL,
  manager_id BIGINT UNSIGNED NULL,
  location_id BIGINT UNSIGNED NULL,
  employment_type VARCHAR(32) NOT NULL DEFAULT 'full_time',
  status VARCHAR(32) NOT NULL DEFAULT 'pending_verification',
  photo_url VARCHAR(255) NULL,
  joining_date DATE NULL,
  date_of_birth DATE NULL,
  address VARCHAR(255) NULL,
  emergency_contact VARCHAR(64) NULL,
  email_verified_at DATETIME(3) NULL,
  mobile_verified_at DATETIME(3) NULL,
  mfa_enabled TINYINT(1) NOT NULL DEFAULT 0,
  mfa_secret VARCHAR(64) NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  last_seen_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deactivated_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_employees_code (employee_code),
  UNIQUE KEY uq_employees_email (email),
  UNIQUE KEY uq_employees_mobile (mobile),
  KEY idx_employees_manager (manager_id),
  KEY idx_employees_department (department_id),
  KEY idx_employees_status (status),
  KEY idx_employees_role (role_id),
  KEY idx_employees_location (location_id),
  CONSTRAINT fk_employees_role FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_employees_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_employees_designation FOREIGN KEY (designation_id) REFERENCES designations (id) ON DELETE SET NULL,
  CONSTRAINT fk_employees_manager FOREIGN KEY (manager_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_employees_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE departments
  ADD CONSTRAINT fk_departments_head FOREIGN KEY (head_employee_id) REFERENCES employees (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS user_permissions (
  employee_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  effect VARCHAR(8) NOT NULL DEFAULT 'grant',
  granted_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (employee_id, permission_id),
  CONSTRAINT fk_user_permissions_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  user_agent VARCHAR(255) NULL,
  ip VARCHAR(64) NULL,
  device VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  revoked_reason VARCHAR(120) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_employee_sessions_token (token_hash),
  KEY idx_employee_sessions_employee (employee_id, expires_at),
  CONSTRAINT fk_employee_sessions_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NULL,
  identifier VARCHAR(190) NOT NULL,
  success TINYINT(1) NOT NULL DEFAULT 0,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  device VARCHAR(64) NULL,
  failure_reason VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_login_history_employee (employee_id, created_at),
  KEY idx_login_history_created (created_at),
  CONSTRAINT fk_login_history_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS otp_verifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NULL,
  identifier VARCHAR(190) NOT NULL,
  channel VARCHAR(16) NOT NULL DEFAULT 'email',
  purpose VARCHAR(40) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ip VARCHAR(64) NULL,
  PRIMARY KEY (id),
  KEY idx_otp_identifier (identifier, purpose, created_at),
  CONSTRAINT fk_otp_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------- Attendance ----------------------------------
CREATE TABLE IF NOT EXISTS attendance (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  work_date DATE NOT NULL,
  check_in_at DATETIME(3) NULL,
  check_out_at DATETIME(3) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'present',
  total_minutes INT NOT NULL DEFAULT 0,
  break_minutes INT NOT NULL DEFAULT 0,
  overtime_minutes INT NOT NULL DEFAULT 0,
  is_late TINYINT(1) NOT NULL DEFAULT 0,
  early_departure TINYINT(1) NOT NULL DEFAULT 0,
  auto_closed TINYINT(1) NOT NULL DEFAULT 0,
  source VARCHAR(24) NOT NULL DEFAULT 'web',
  notes VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_employee_date (employee_id, work_date),
  KEY idx_attendance_date (work_date),
  KEY idx_attendance_status (status),
  CONSTRAINT fk_attendance_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_breaks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  attendance_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  minutes INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_attendance_breaks_attendance (attendance_id),
  CONSTRAINT fk_attendance_breaks_attendance FOREIGN KEY (attendance_id) REFERENCES attendance (id) ON DELETE CASCADE,
  CONSTRAINT fk_attendance_breaks_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_corrections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  attendance_id BIGINT UNSIGNED NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  work_date DATE NOT NULL,
  requested_check_in DATETIME(3) NULL,
  requested_check_out DATETIME(3) NULL,
  reason TEXT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  review_note VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_corrections_employee (employee_id, created_at),
  KEY idx_corrections_status (status),
  CONSTRAINT fk_corrections_attendance FOREIGN KEY (attendance_id) REFERENCES attendance (id) ON DELETE SET NULL,
  CONSTRAINT fk_corrections_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_corrections_reviewer FOREIGN KEY (reviewed_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------ Files -------------------------------------
CREATE TABLE IF NOT EXISTS files (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id BIGINT UNSIGNED NULL,
  storage_key VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  is_private TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_files_owner (owner_id),
  CONSTRAINT fk_files_owner FOREIGN KEY (owner_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------- Projects -----------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(24) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description TEXT NULL,
  manager_id BIGINT UNSIGNED NULL,
  department_id BIGINT UNSIGNED NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'planning',
  start_date DATE NULL,
  end_date DATE NULL,
  progress INT NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_projects_code (code),
  KEY idx_projects_manager (manager_id),
  CONSTRAINT fk_projects_manager FOREIGN KEY (manager_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_projects_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_projects_created_by FOREIGN KEY (created_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  project_role VARCHAR(48) NOT NULL DEFAULT 'member',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_members (project_id, employee_id),
  CONSTRAINT fk_project_members_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  CONSTRAINT fk_project_members_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_milestones (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(160) NOT NULL,
  description VARCHAR(255) NULL,
  due_date DATE NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_milestones_project (project_id),
  CONSTRAINT fk_milestones_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------ Tasks -------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_no VARCHAR(24) NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NULL,
  category VARCHAR(64) NULL,
  department_id BIGINT UNSIGNED NULL,
  project_id BIGINT UNSIGNED NULL,
  milestone_id BIGINT UNSIGNED NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'medium',
  status VARCHAR(24) NOT NULL DEFAULT 'not_started',
  created_by BIGINT UNSIGNED NOT NULL,
  manager_id BIGINT UNSIGNED NULL,
  start_date DATE NULL,
  due_date DATE NULL,
  due_time TIME NULL,
  estimated_minutes INT NULL,
  instructions TEXT NULL,
  remarks TEXT NULL,
  progress INT NOT NULL DEFAULT 0,
  recurrence VARCHAR(16) NOT NULL DEFAULT 'none',
  recurrence_end_date DATE NULL,
  parent_task_id BIGINT UNSIGNED NULL,
  submitted_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  approved_at DATETIME(3) NULL,
  approved_by BIGINT UNSIGNED NULL,
  rejection_reason VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  archived_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tasks_task_no (task_no),
  KEY idx_tasks_status_due (status, due_date),
  KEY idx_tasks_department (department_id),
  KEY idx_tasks_creator (created_by),
  KEY idx_tasks_manager (manager_id),
  KEY idx_tasks_project (project_id),
  CONSTRAINT fk_tasks_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_milestone FOREIGN KEY (milestone_id) REFERENCES project_milestones (id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_creator FOREIGN KEY (created_by) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_tasks_manager FOREIGN KEY (manager_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_parent FOREIGN KEY (parent_task_id) REFERENCES tasks (id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_approved_by FOREIGN KEY (approved_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  assigned_by BIGINT UNSIGNED NOT NULL,
  assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  accepted_at DATETIME(3) NULL,
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'assigned',
  time_spent_minutes INT NOT NULL DEFAULT 0,
  completion_note TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_task_assignments (task_id, employee_id),
  KEY idx_task_assignments_employee (employee_id, status),
  CONSTRAINT fk_task_assignments_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
  CONSTRAINT fk_task_assignments_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_task_assignments_assigner FOREIGN KEY (assigned_by) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_subtasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  is_done TINYINT(1) NOT NULL DEFAULT 0,
  position INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_subtasks_task (task_id),
  CONSTRAINT fk_subtasks_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_task_comments_task (task_id, created_at),
  CONSTRAINT fk_task_comments_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
  CONSTRAINT fk_task_comments_author FOREIGN KEY (author_id) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id BIGINT UNSIGNED NOT NULL,
  file_id BIGINT UNSIGNED NOT NULL,
  uploaded_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_task_attachments_task (task_id),
  CONSTRAINT fk_task_attachments_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
  CONSTRAINT fk_task_attachments_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_time_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  minutes INT NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL,
  is_manual TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_task_time_logs_task (task_id),
  KEY idx_task_time_logs_employee (employee_id),
  CONSTRAINT fk_task_time_logs_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
  CONSTRAINT fk_task_time_logs_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------- Daily work reports ------------------------------
CREATE TABLE IF NOT EXISTS daily_work_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  report_date DATE NOT NULL,
  work_start TIME NULL,
  work_end TIME NULL,
  total_minutes INT NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  problems TEXT NULL,
  support_required TEXT NULL,
  tomorrow_plan TEXT NULL,
  tasks_completed INT NOT NULL DEFAULT 0,
  tasks_in_progress INT NOT NULL DEFAULT 0,
  tasks_pending INT NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'submitted',
  submitted_at DATETIME(3) NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  review_note VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_daily_reports_employee_date (employee_id, report_date),
  KEY idx_daily_reports_date (report_date),
  KEY idx_daily_reports_status (status),
  CONSTRAINT fk_daily_reports_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_daily_reports_reviewer FOREIGN KEY (reviewed_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS daily_report_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_id BIGINT UNSIGNED NOT NULL,
  file_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_report_attachments_report (report_id),
  CONSTRAINT fk_report_attachments_report FOREIGN KEY (report_id) REFERENCES daily_work_reports (id) ON DELETE CASCADE,
  CONSTRAINT fk_report_attachments_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------ Tickets -----------------------------------
CREATE TABLE IF NOT EXISTS tickets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_no VARCHAR(24) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(64) NOT NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'medium',
  status VARCHAR(32) NOT NULL DEFAULT 'new',
  department_id BIGINT UNSIGNED NULL,
  requester_id BIGINT UNSIGNED NOT NULL,
  assigned_team VARCHAR(64) NULL,
  assignee_id BIGINT UNSIGNED NULL,
  related_task_id BIGINT UNSIGNED NULL,
  sla_due_at DATETIME(3) NULL,
  acknowledged_at DATETIME(3) NULL,
  resolved_at DATETIME(3) NULL,
  closed_at DATETIME(3) NULL,
  resolution TEXT NULL,
  feedback_rating TINYINT NULL,
  feedback_comment VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tickets_no (ticket_no),
  KEY idx_tickets_status (status),
  KEY idx_tickets_requester (requester_id),
  KEY idx_tickets_assignee (assignee_id),
  KEY idx_tickets_sla (sla_due_at),
  CONSTRAINT fk_tickets_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_tickets_requester FOREIGN KEY (requester_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_tickets_assignee FOREIGN KEY (assignee_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_tickets_task FOREIGN KEY (related_task_id) REFERENCES tasks (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  is_internal TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ticket_comments_ticket (ticket_id, created_at),
  CONSTRAINT fk_ticket_comments_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_comments_author FOREIGN KEY (author_id) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  assigned_by BIGINT UNSIGNED NULL,
  assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  note VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY idx_ticket_assignments_ticket (ticket_id),
  CONSTRAINT fk_ticket_assignments_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_assignments_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  file_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ticket_attachments_ticket (ticket_id),
  CONSTRAINT fk_ticket_attachments_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_attachments_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------- Messaging -----------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conv_type VARCHAR(16) NOT NULL DEFAULT 'direct',
  name VARCHAR(160) NULL,
  description VARCHAR(255) NULL,
  department_id BIGINT UNSIGNED NULL,
  is_announcement TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_conversations_type (conv_type),
  CONSTRAINT fk_conversations_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_conversations_created_by FOREIGN KEY (created_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversation_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  member_role VARCHAR(16) NOT NULL DEFAULT 'member',
  joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_read_at DATETIME(3) NULL,
  is_muted TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_conversation_members (conversation_id, employee_id),
  KEY idx_conversation_members_employee (employee_id),
  CONSTRAINT fk_conversation_members_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_conversation_members_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  body TEXT NULL,
  message_type VARCHAR(16) NOT NULL DEFAULT 'text',
  reply_to_id BIGINT UNSIGNED NULL,
  edited_at DATETIME(3) NULL,
  deleted_at DATETIME(3) NULL,
  deleted_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_messages_conversation (conversation_id, id),
  KEY idx_messages_sender (sender_id),
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_messages_reply FOREIGN KEY (reply_to_id) REFERENCES messages (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id BIGINT UNSIGNED NOT NULL,
  file_id BIGINT UNSIGNED NOT NULL,
  duration_seconds INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_message_attachments_message (message_id),
  CONSTRAINT fk_message_attachments_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
  CONSTRAINT fk_message_attachments_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  delivered_at DATETIME(3) NULL,
  read_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_message_receipts (message_id, employee_id),
  KEY idx_message_receipts_employee (employee_id, read_at),
  CONSTRAINT fk_message_receipts_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
  CONSTRAINT fk_message_receipts_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------- Announcements and notifications ----------------------
CREATE TABLE IF NOT EXISTS announcements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'normal',
  created_by BIGINT UNSIGNED NOT NULL,
  audience_type VARCHAR(24) NOT NULL DEFAULT 'all',
  audience_value VARCHAR(255) NULL,
  published_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_announcements_published (published_at),
  CONSTRAINT fk_announcements_author FOREIGN KEY (created_by) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  notif_type VARCHAR(48) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body VARCHAR(500) NULL,
  link VARCHAR(255) NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'normal',
  actor_id BIGINT UNSIGNED NULL,
  announcement_id BIGINT UNSIGNED NULL,
  dedupe_key VARCHAR(160) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_notifications_created (created_at),
  UNIQUE KEY uq_notifications_dedupe (dedupe_key),
  CONSTRAINT fk_notifications_actor FOREIGN KEY (actor_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_notifications_announcement FOREIGN KEY (announcement_id) REFERENCES announcements (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notification_recipients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  notification_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_notification_recipients (notification_id, employee_id),
  KEY idx_notification_recipients_employee (employee_id, read_at),
  CONSTRAINT fk_notification_recipients_notification FOREIGN KEY (notification_id) REFERENCES notifications (id) ON DELETE CASCADE,
  CONSTRAINT fk_notification_recipients_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------- Calendar / leave -----------------------------
CREATE TABLE IF NOT EXISTS holidays (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  holiday_date DATE NOT NULL,
  holiday_type VARCHAR(24) NOT NULL DEFAULT 'public',
  location_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_holidays_date_name (holiday_date, name),
  CONSTRAINT fk_holidays_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leave_types (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(80) NOT NULL,
  code VARCHAR(24) NOT NULL,
  annual_quota INT NOT NULL DEFAULT 0,
  is_paid TINYINT(1) NOT NULL DEFAULT 1,
  requires_document TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_leave_types_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leave_balances (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  leave_type_id BIGINT UNSIGNED NOT NULL,
  balance_year SMALLINT NOT NULL,
  allocated DECIMAL(6, 1) NOT NULL DEFAULT 0,
  used DECIMAL(6, 1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_leave_balances (employee_id, leave_type_id, balance_year),
  CONSTRAINT fk_leave_balances_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_leave_balances_type FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leave_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  leave_type_id BIGINT UNSIGNED NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days DECIMAL(5, 1) NOT NULL,
  reason TEXT NOT NULL,
  document_file_id BIGINT UNSIGNED NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending_manager',
  manager_id BIGINT UNSIGNED NULL,
  manager_action_at DATETIME(3) NULL,
  hr_action_at DATETIME(3) NULL,
  decision_note VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_leave_requests_employee (employee_id, start_date),
  KEY idx_leave_requests_status (status),
  CONSTRAINT fk_leave_requests_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_leave_requests_type FOREIGN KEY (leave_type_id) REFERENCES leave_types (id),
  CONSTRAINT fk_leave_requests_manager FOREIGN KEY (manager_id) REFERENCES employees (id) ON DELETE SET NULL,
  CONSTRAINT fk_leave_requests_document FOREIGN KEY (document_file_id) REFERENCES files (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------ Meetings ----------------------------------
CREATE TABLE IF NOT EXISTS meetings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(200) NOT NULL,
  description TEXT NULL,
  agenda TEXT NULL,
  organizer_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  location_type VARCHAR(16) NOT NULL DEFAULT 'online',
  room_name VARCHAR(120) NULL,
  start_at DATETIME(3) NOT NULL,
  end_at DATETIME(3) NOT NULL,
  meeting_code CHAR(36) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'scheduled',
  outcome TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_meetings_code (meeting_code),
  KEY idx_meetings_start (start_at),
  CONSTRAINT fk_meetings_organizer FOREIGN KEY (organizer_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_meetings_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meeting_participants (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  response VARCHAR(16) NOT NULL DEFAULT 'pending',
  attended TINYINT(1) NOT NULL DEFAULT 0,
  joined_at DATETIME(3) NULL,
  left_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_meeting_participants (meeting_id, employee_id),
  KEY idx_meeting_participants_employee (employee_id),
  CONSTRAINT fk_meeting_participants_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_participants_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meeting_action_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  assignee_id BIGINT UNSIGNED NULL,
  due_date DATE NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_action_items_meeting (meeting_id),
  CONSTRAINT fk_action_items_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE,
  CONSTRAINT fk_action_items_assignee FOREIGN KEY (assignee_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meeting_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  body VARCHAR(1000) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_meeting_messages_meeting (meeting_id, id),
  CONSTRAINT fk_meeting_messages_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_messages_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------- KPI ------------------------------------
CREATE TABLE IF NOT EXISTS kpi_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_kpi_templates_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kpi_parameters (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  template_id BIGINT UNSIGNED NOT NULL,
  param_key VARCHAR(48) NOT NULL,
  label VARCHAR(120) NOT NULL,
  weight DECIMAL(5, 2) NOT NULL,
  description VARCHAR(255) NULL,
  data_source VARCHAR(64) NULL,
  position INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_kpi_parameters (template_id, param_key),
  CONSTRAINT fk_kpi_parameters_template FOREIGN KEY (template_id) REFERENCES kpi_templates (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_kpi_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  template_id BIGINT UNSIGNED NOT NULL,
  period CHAR(7) NOT NULL,
  scores JSON NOT NULL,
  metrics JSON NOT NULL,
  total_score DECIMAL(5, 2) NOT NULL DEFAULT 0,
  category VARCHAR(32) NULL,
  strengths TEXT NULL,
  improvements TEXT NULL,
  manager_comment TEXT NULL,
  employee_comment TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  computed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  published_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_kpi_employee_period (employee_id, period),
  KEY idx_kpi_period (period),
  CONSTRAINT fk_kpi_records_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE RESTRICT,
  CONSTRAINT fk_kpi_records_template FOREIGN KEY (template_id) REFERENCES kpi_templates (id),
  CONSTRAINT fk_kpi_records_reviewer FOREIGN KEY (reviewed_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS manager_reviews (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  period CHAR(7) NOT NULL,
  reviewer_id BIGINT UNSIGNED NOT NULL,
  rating TINYINT NOT NULL,
  comments TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_manager_reviews_employee (employee_id, period),
  CONSTRAINT fk_manager_reviews_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_manager_reviews_reviewer FOREIGN KEY (reviewer_id) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------ Audit / system / jobs ---------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id BIGINT UNSIGNED NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(48) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  before_data JSON NULL,
  after_data JSON NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_actor (actor_id, created_at),
  KEY idx_audit_action (action),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key VARCHAR(64) NOT NULL,
  setting_value TEXT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_settings_updated_by FOREIGN KEY (updated_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS job_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_name VARCHAR(64) NOT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  message VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY idx_job_runs_name (job_name, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
