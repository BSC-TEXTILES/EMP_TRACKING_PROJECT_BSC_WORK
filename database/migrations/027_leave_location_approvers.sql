-- Persist location and HR routing for new leave requests; preserve historical records.
ALTER TABLE leave_requests
  ADD COLUMN request_location_id BIGINT UNSIGNED NULL,
  ADD COLUMN hr_approver_id BIGINT UNSIGNED NULL,
  ADD KEY idx_leave_location_status (request_location_id, status),
  ADD KEY idx_leave_hr_status (hr_approver_id, status),
  ADD CONSTRAINT fk_leave_request_location FOREIGN KEY (request_location_id) REFERENCES locations(id),
  ADD CONSTRAINT fk_leave_hr_approver FOREIGN KEY (hr_approver_id) REFERENCES employees(id);
