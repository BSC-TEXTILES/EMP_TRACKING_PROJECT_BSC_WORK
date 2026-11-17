-- Migration 023: Role-Based Daily Task Management & Employee Performance Monitoring (Master SOP 1.0)
-- Applicable for Davanagere (DAV), Shivamogga (SHI), and Belagavi (BEL) stores.

-- 1. Ensure retail designations exist for the 11 hierarchy levels
INSERT INTO designations (title, department_id, level, code)
SELECT 'Section Supervisor', id, 10, 'SEC_SUP' FROM departments WHERE code = 'RETAIL'
ON DUPLICATE KEY UPDATE level = 10;

INSERT INTO designations (title, department_id, level, code)
SELECT 'Billing Supervisor', id, 10, 'BILL_SUP' FROM departments WHERE code = 'RETAIL'
ON DUPLICATE KEY UPDATE level = 10;

INSERT INTO designations (title, department_id, level, code)
SELECT 'Cashier Supervisor', id, 10, 'CASH_SUP' FROM departments WHERE code = 'RETAIL'
ON DUPLICATE KEY UPDATE level = 10;

INSERT INTO designations (title, department_id, level, code)
SELECT 'Warehouse Manager', id, 13, 'WH_MGR' FROM departments WHERE code = 'RETAIL'
ON DUPLICATE KEY UPDATE level = 13;

INSERT INTO designations (title, department_id, level, code)
SELECT 'Warehouse Staff', id, 4, 'WH_STF' FROM departments WHERE code = 'RETAIL'
ON DUPLICATE KEY UPDATE level = 4;

-- 2. Alter tasks table to support time slots, evidence verification, and numerical metrics
SET @has_time_slot := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'time_slot');
SET @sql_time_slot := IF(@has_time_slot = 0, 'ALTER TABLE tasks ADD COLUMN time_slot VARCHAR(24) NOT NULL DEFAULT \'operations\' AFTER milestone_id', 'SELECT 1');
PREPARE stmt1 FROM @sql_time_slot; EXECUTE stmt1; DEALLOCATE PREPARE stmt1;

SET @has_requires_evidence := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'requires_evidence');
SET @sql_requires_evidence := IF(@has_requires_evidence = 0, 'ALTER TABLE tasks ADD COLUMN requires_evidence TINYINT(1) NOT NULL DEFAULT 0 AFTER instructions', 'SELECT 1');
PREPARE stmt2 FROM @sql_requires_evidence; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

SET @has_evidence_type := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'evidence_type');
SET @sql_evidence_type := IF(@has_evidence_type = 0, 'ALTER TABLE tasks ADD COLUMN evidence_type VARCHAR(64) NULL AFTER requires_evidence', 'SELECT 1');
PREPARE stmt3 FROM @sql_evidence_type; EXECUTE stmt3; DEALLOCATE PREPARE stmt3;

SET @has_evidence_file_id := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'evidence_file_id');
SET @sql_evidence_file_id := IF(@has_evidence_file_id = 0, 'ALTER TABLE tasks ADD COLUMN evidence_file_id BIGINT UNSIGNED NULL AFTER evidence_type', 'SELECT 1');
PREPARE stmt4 FROM @sql_evidence_file_id; EXECUTE stmt4; DEALLOCATE PREPARE stmt4;

SET @has_requires_metric := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'requires_metric');
SET @sql_requires_metric := IF(@has_requires_metric = 0, 'ALTER TABLE tasks ADD COLUMN requires_metric TINYINT(1) NOT NULL DEFAULT 0 AFTER evidence_file_id', 'SELECT 1');
PREPARE stmt5 FROM @sql_requires_metric; EXECUTE stmt5; DEALLOCATE PREPARE stmt5;

SET @has_metric_label := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'metric_label');
SET @sql_metric_label := IF(@has_metric_label = 0, 'ALTER TABLE tasks ADD COLUMN metric_label VARCHAR(64) NULL AFTER requires_metric', 'SELECT 1');
PREPARE stmt6 FROM @sql_metric_label; EXECUTE stmt6; DEALLOCATE PREPARE stmt6;

SET @has_metric_value := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'metric_value');
SET @sql_metric_value := IF(@has_metric_value = 0, 'ALTER TABLE tasks ADD COLUMN metric_value DECIMAL(14,2) NULL AFTER metric_label', 'SELECT 1');
PREPARE stmt7 FROM @sql_metric_value; EXECUTE stmt7; DEALLOCATE PREPARE stmt7;

SET @has_metric_unit := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'metric_unit');
SET @sql_metric_unit := IF(@has_metric_unit = 0, 'ALTER TABLE tasks ADD COLUMN metric_unit VARCHAR(24) NULL AFTER metric_value', 'SELECT 1');
PREPARE stmt8 FROM @sql_metric_unit; EXECUTE stmt8; DEALLOCATE PREPARE stmt8;

SET @has_verification_status := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'verification_status');
SET @sql_verification_status := IF(@has_verification_status = 0, 'ALTER TABLE tasks ADD COLUMN verification_status VARCHAR(24) NOT NULL DEFAULT \'unverified\' AFTER status', 'SELECT 1');
PREPARE stmt9 FROM @sql_verification_status; EXECUTE stmt9; DEALLOCATE PREPARE stmt9;

-- 3. Master Task Templates Table
CREATE TABLE IF NOT EXISTS task_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  designation_title VARCHAR(100) NOT NULL,
  role_level INT NOT NULL DEFAULT 1,
  time_slot ENUM('morning', 'operations', 'evening', 'closing') NOT NULL DEFAULT 'operations',
  task_order INT NOT NULL DEFAULT 1,
  title VARCHAR(200) NOT NULL,
  description TEXT NULL,
  priority ENUM('critical', 'high', 'medium', 'low') NOT NULL DEFAULT 'medium',
  requires_evidence TINYINT(1) NOT NULL DEFAULT 0,
  evidence_type VARCHAR(64) NULL,
  requires_metric TINYINT(1) NOT NULL DEFAULT 0,
  metric_label VARCHAR(64) NULL,
  metric_unit VARCHAR(24) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_task_templates_role_slot (designation_title, time_slot, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Daily Timeline Checkpoints Table (Morning-to-Night Activity Tracking)
CREATE TABLE IF NOT EXISTS store_daily_checkpoints (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  store_id BIGINT UNSIGNED NULL,
  checkpoint_date DATE NOT NULL,
  time_slot VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  summary TEXT NULL,
  issues_identified TEXT NULL,
  escalated_to BIGINT UNSIGNED NULL,
  submitted_at DATETIME(3) NULL,
  verified_at DATETIME(3) NULL,
  verified_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_store_checkpoint_emp (employee_id, checkpoint_date, time_slot),
  KEY idx_store_checkpoint_date (checkpoint_date, status),
  CONSTRAINT fk_checkpoint_emp FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. 100-Point Daily Performance Scores Table
CREATE TABLE IF NOT EXISTS employee_daily_performance (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id BIGINT UNSIGNED NOT NULL,
  evaluation_date DATE NOT NULL,
  task_completion_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  timely_completion_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  quality_accuracy_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  reporting_doc_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  attendance_punctuality_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  team_coordination_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  escalation_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  total_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  rating VARCHAR(32) NOT NULL DEFAULT 'Good',
  evaluated_by BIGINT UNSIGNED NULL,
  remarks TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_emp_daily_perf (employee_id, evaluation_date),
  KEY idx_emp_perf_date (evaluation_date, total_score),
  CONSTRAINT fk_emp_daily_perf FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Seed SOP Role Templates for Store Manager, Cashier, CRM Manager, Warehouse Manager
INSERT INTO task_templates (designation_title, role_level, time_slot, task_order, title, description, priority, requires_evidence, evidence_type, requires_metric, metric_label, metric_unit) VALUES
-- Store Manager: Morning
('Store Manager', 1, 'morning', 1, 'Check previous day total sales', 'Verify sales report across all floors and store departments', 'high', 1, 'sales_report', 1, 'Total Sales', '₹'),
('Store Manager', 1, 'morning', 2, 'Check previous day cash collection & bank deposit', 'Verify physical vs system cash and confirm bank deposit slip', 'critical', 1, 'bank_deposit_slip', 1, 'Cash Deposited', '₹'),
('Store Manager', 1, 'morning', 3, 'Verify opening cash balance & cash locker security', 'Ensure physical locker is securely locked and opening float is verified', 'critical', 1, 'physical_inspection', 1, 'Opening Balance', '₹'),
('Store Manager', 1, 'morning', 4, 'Review unsettled bills & pending parcels', 'Examine pending bills from previous day and audit parcel backlog', 'high', 1, 'unsettled_bill_report', 1, 'Unsettled Bills', 'count'),
('Store Manager', 1, 'morning', 5, 'Review staff attendance & conduct morning operational briefing', 'Check present vs absent staff and conduct morning briefing with sales targets', 'high', 1, 'briefing_confirmation', 1, 'Staff Present', 'count'),

-- Store Manager: Operations
('Store Manager', 1, 'operations', 1, 'Monitor store-wide & floor-wise sales targets', 'Review hourly sales velocity against daily revenue targets', 'high', 0, NULL, 1, 'Current Sales', '₹'),
('Store Manager', 1, 'operations', 2, 'Inspect floor staff allocation & ensure no vacant sections', 'Walk all store floors to verify employee availability in every section', 'high', 1, 'floor_walk_photo', 0, NULL, NULL),
('Store Manager', 1, 'operations', 3, 'Review customer complaints & CRM negative feedback', 'Address escalated customer issues with floor managers and CRM team', 'high', 1, 'complaint_register', 1, 'Open Complaints', 'count'),

-- Store Manager: Closing (Mandatory)
('Store Manager', 1, 'closing', 1, 'Verify total cash collection vs system sales', 'Match physical cash with collection statements; record differences explicitly', 'critical', 1, 'cash_closing_statement', 1, 'Cash Difference', '₹'),
('Store Manager', 1, 'closing', 2, 'Confirm cash handover & verify cash locker is locked', 'Verify physical cash handover to safe locker and lock security', 'critical', 1, 'locker_verification', 0, NULL, NULL),
('Store Manager', 1, 'closing', 3, 'Review checkout attendance & submit final store closing report', 'Ensure all employees have completed checkout and submit store report', 'critical', 1, 'store_closing_report', 0, NULL, NULL),

-- Cashier: Morning
('Cashier', 7, 'morning', 1, 'Report to assigned counter & verify opening cash balance', 'Count cash denominations and confirm opening change received from supervisor', 'critical', 1, 'cash_register', 1, 'Opening Cash', '₹'),
('Cashier', 7, 'morning', 2, 'Inspect POS machine, barcode scanner & UPI QR codes', 'Ensure all payment hardware and QR display cards are operational', 'high', 0, NULL, 0, NULL, NULL),

-- Cashier: Operations
('Cashier', 7, 'operations', 1, 'Process customer bill payments accurately', 'Collect payments via Cash/Card/UPI and provide exact change without duplicate entries', 'high', 0, NULL, 1, 'Bills Processed', 'count'),
('Cashier', 7, 'operations', 2, 'Monitor counter cash limits & report shortages immediately', 'Report any payment transaction failure or cash discrepancy to supervisor', 'critical', 0, NULL, 0, NULL, NULL),

-- Cashier: Closing
('Cashier', 7, 'closing', 1, 'Count physical cash & match with system collection', 'Reconcile drawer cash with billing system collection statements', 'critical', 1, 'cash_reconciliation_slip', 1, 'Cash Difference', '₹'),
('Cashier', 7, 'closing', 2, 'Complete cash handover to Cashier Supervisor', 'Hand over physical cash and obtain formal signature confirmation', 'critical', 1, 'handover_confirmation', 0, NULL, NULL),

-- CRM Manager: Morning
('CRM Manager', 8, 'morning', 1, 'Enter previous day total bill count in CRM software', 'Verify billing report count and input into customer feedback register', 'high', 1, 'billing_report', 1, 'Total Bills', 'count'),
('CRM Manager', 8, 'morning', 2, 'Review customer feedback % & analyze negative reviews', 'Calculate collection % (Target >= 80%) and escalate negative feedback', 'high', 1, 'feedback_report', 1, 'Collection %', '%'),
('CRM Manager', 8, 'morning', 3, 'Deploy CRM Executives to all customer entrance & floor points', 'Verify greeting readiness and staff allocation across all store floors', 'high', 1, 'deployment_report', 1, 'Executives Deployed', 'count'),

-- CRM Manager: Operations
('CRM Manager', 8, 'operations', 1, 'Hourly greeting & customer feedback collection audit', 'Monitor floor customer engagement and verify feedback accuracy with consent', 'high', 0, NULL, 1, 'Feedbacks Today', 'count'),
('CRM Manager', 8, 'operations', 2, 'Resolve customer complaints & record sourcing diversions', 'Actively follow up on customer dissatisfaction and log diversion reasons', 'high', 1, 'complaint_register', 1, 'Resolved Complaints', 'count'),

-- CRM Manager: Closing
('CRM Manager', 8, 'closing', 1, 'Calculate daily feedback collection percentage & submit final CRM report', 'Summarize total bills, feedback collected %, and complaints resolved', 'critical', 1, 'final_crm_report', 1, 'Final Feedback %', '%'),

-- Warehouse Manager: Morning
('Warehouse Manager', 10, 'morning', 1, 'Check expected incoming vehicles & pending parcel receipts', 'Log expected supplier shipments and verify unloading bay space', 'high', 1, 'delivery_documents', 1, 'Expected Parcels', 'count'),

-- Warehouse Manager: Operations
('Warehouse Manager', 10, 'operations', 1, 'Record vehicle arrivals, count parcels & inspect for damages', 'Log vehicle number, arrival time, parcel count, and photograph damaged parcels', 'high', 1, 'parcel_photograph', 1, 'Parcels Unloaded', 'count'),
('Warehouse Manager', 10, 'operations', 2, 'Open parcels, verify quantities & generate barcodes', 'Count items against delivery challan and generate barcode tags for eligible stock', 'high', 1, 'barcode_report', 1, 'Barcodes Generated', 'count'),
('Warehouse Manager', 10, 'operations', 3, 'Process floor stock transfer requests with documentation', 'Pick requested products and obtain floor receiving acknowledgement', 'high', 1, 'stock_transfer_doc', 1, 'Items Transferred', 'count'),

-- Warehouse Manager: Closing
('Warehouse Manager', 10, 'closing', 1, 'Reconcile parcels received, opened, barcodes & submit warehouse closing report', 'Verify unprocessed stock is safely segregated and submit closing report', 'critical', 1, 'warehouse_closing_report', 1, 'Pending Barcodes', 'count')
ON DUPLICATE KEY UPDATE title = VALUES(title);
