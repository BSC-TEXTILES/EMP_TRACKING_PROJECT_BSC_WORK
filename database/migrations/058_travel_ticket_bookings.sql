-- Migration 058: Travel and Ticket Booking System for BSC Textiles HRMS
-- Provides comprehensive daily bus and train booking records, multi-passenger support,
-- store isolation (BEL, DAV, SHI, HQ), booking status lifecycle, and audit logs.

CREATE TABLE IF NOT EXISTS travel_bookings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_reference VARCHAR(64) NOT NULL UNIQUE,
  employee_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NOT NULL,
  transport_type ENUM('bus', 'train') NOT NULL,
  status ENUM('requested', 'pending', 'confirmed', 'cancelled', 'rejected', 'completed') NOT NULL DEFAULT 'confirmed',
  booking_date DATE NOT NULL,
  booked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  journey_date DATE NOT NULL,
  journey_time TIME NULL,
  return_date DATE NULL,
  source_location VARCHAR(150) NOT NULL,
  destination_location VARCHAR(150) NOT NULL,
  boarding_point VARCHAR(150) NULL,
  dropping_point VARCHAR(150) NULL,
  operator_or_train_name VARCHAR(150) NULL,
  train_number VARCHAR(32) NULL,
  pnr_or_ticket_number VARCHAR(64) NULL,
  seat_class VARCHAR(50) NULL,
  seat_numbers VARCHAR(100) NULL,
  passenger_count INT NOT NULL DEFAULT 1,
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  purpose VARCHAR(255) NULL,
  booked_by_id BIGINT UNSIGNED NOT NULL,
  notes TEXT NULL,
  attachment_url VARCHAR(500) NULL,
  cancellation_reason VARCHAR(255) NULL,
  cancelled_at DATETIME NULL,
  cancelled_by_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_travel_emp (employee_id),
  INDEX idx_travel_loc (location_id),
  INDEX idx_travel_type (transport_type),
  INDEX idx_travel_status (status),
  INDEX idx_travel_booking_date (booking_date),
  INDEX idx_travel_journey_date (journey_date),
  CONSTRAINT fk_travel_emp FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_travel_loc FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_travel_booked_by FOREIGN KEY (booked_by_id) REFERENCES employees (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS travel_passengers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id BIGINT UNSIGNED NOT NULL,
  passenger_name VARCHAR(150) NOT NULL,
  age INT NULL,
  gender ENUM('male', 'female', 'other') NULL,
  seat_berth VARCHAR(32) NULL,
  ticket_number VARCHAR(64) NULL,
  status ENUM('confirmed', 'cancelled', 'waitlisted', 'rac') NOT NULL DEFAULT 'confirmed',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pass_booking (booking_id),
  CONSTRAINT fk_pass_booking FOREIGN KEY (booking_id) REFERENCES travel_bookings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS travel_booking_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(50) NOT NULL,
  previous_status VARCHAR(32) NULL,
  new_status VARCHAR(32) NULL,
  remarks TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_log_booking (booking_id),
  CONSTRAINT fk_log_booking FOREIGN KEY (booking_id) REFERENCES travel_bookings (id) ON DELETE CASCADE,
  CONSTRAINT fk_log_actor FOREIGN KEY (actor_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Safely seed initial travel bookings when referenced employees exist
INSERT INTO travel_bookings (
  id, booking_reference, employee_id, location_id, transport_type, status,
  booking_date, booked_at, journey_date, journey_time,
  source_location, destination_location, boarding_point, dropping_point,
  operator_or_train_name, train_number, pnr_or_ticket_number, seat_class, seat_numbers,
  passenger_count, total_amount, purpose, booked_by_id, notes
)
SELECT 1, 'TRV-20261124-001', e.id, 1, 'bus', 'confirmed',
 '2026-11-24', '2026-11-24 09:30:00', '2026-11-25', '22:00:00',
 'Belagavi', 'Bengaluru', 'CBT Belagavi', 'Majestic',
 'KSRTC Airavat Club Class', NULL, 'KSRTC-BLG-88491', 'AC Multi-Axle Sleeper', '14, 15',
 2, 2400.00, 'Quarterly Textile Vendor Meet & Fabric Sourcing', b.id, 'Approved by Store HR'
FROM employees e, employees b WHERE e.id = 25 AND b.id = 37
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

INSERT INTO travel_bookings (
  id, booking_reference, employee_id, location_id, transport_type, status,
  booking_date, booked_at, journey_date, journey_time,
  source_location, destination_location, boarding_point, dropping_point,
  operator_or_train_name, train_number, pnr_or_ticket_number, seat_class, seat_numbers,
  passenger_count, total_amount, purpose, booked_by_id, notes
)
SELECT 2, 'TRV-20261124-002', e.id, 1, 'train', 'confirmed',
 '2026-11-24', '2026-11-24 10:15:00', '2026-11-26', '18:15:00',
 'Belagavi', 'Hubballi', 'Belagavi Railway Station (BGM)', 'Hubballi Junction (UBL)',
 'Rani Chennamma Express', '16589', '425-9831045', 'Chair Car (CC)', 'C1-42',
 1, 380.00, 'Inter-Store Inventory Audit', b.id, 'One-way official ticket'
FROM employees e, employees b WHERE e.id = 26 AND b.id = 37
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

INSERT INTO travel_bookings (
  id, booking_reference, employee_id, location_id, transport_type, status,
  booking_date, booked_at, journey_date, journey_time,
  source_location, destination_location, boarding_point, dropping_point,
  operator_or_train_name, train_number, pnr_or_ticket_number, seat_class, seat_numbers,
  passenger_count, total_amount, purpose, booked_by_id, notes
)
SELECT 3, 'TRV-20261124-003', e.id, 1, 'bus', 'pending',
 '2026-11-24', '2026-11-24 11:20:00', '2026-11-27', '21:30:00',
 'Belagavi', 'Pune', 'Chennamma Circle', 'Swargate',
 'VRL Travels', NULL, 'VRL-77312', 'AC Sleeper', 'L4',
 1, 950.00, 'Retail Merchandising Workshop', b.id, 'Awaiting final schedule confirmation'
FROM employees e, employees b WHERE e.id = 27 AND b.id = 37
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- DAV Store Bookings
INSERT INTO travel_bookings (
  id, booking_reference, employee_id, location_id, transport_type, status,
  booking_date, booked_at, journey_date, journey_time,
  source_location, destination_location, boarding_point, dropping_point,
  operator_or_train_name, train_number, pnr_or_ticket_number, seat_class, seat_numbers,
  passenger_count, total_amount, purpose, booked_by_id, notes
)
SELECT 4, 'TRV-20261124-004', e.id, 2, 'train', 'confirmed',
 '2026-11-24', '2026-11-24 08:45:00', '2026-11-25', '06:15:00',
 'Davanagere', 'Bengaluru', 'Davanagere Station (DVG)', 'KSR Bengaluru (SBC)',
 'Jan Shatabdi Express', '12080', '481-2245901', 'AC Chair Car (CC)', 'C2-18, C2-19',
 2, 1180.00, 'Head Office Management Review & Training', b.id, 'Travel with assistant store supervisor'
FROM employees e, employees b WHERE e.id = 3 AND b.id = 38
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

INSERT INTO travel_bookings (
  id, booking_reference, employee_id, location_id, transport_type, status,
  booking_date, booked_at, journey_date, journey_time,
  source_location, destination_location, boarding_point, dropping_point,
  operator_or_train_name, train_number, pnr_or_ticket_number, seat_class, seat_numbers,
  passenger_count, total_amount, purpose, booked_by_id, notes
)
SELECT 5, 'TRV-20261124-005', e.id, 2, 'bus', 'confirmed',
 '2026-11-24', '2026-11-24 11:00:00', '2026-11-24', '23:00:00',
 'Davanagere', 'Shivamogga', 'Davanagere KSRTC Bus Stand', 'Shivamogga Bus Stand',
 'KSRTC Rajahamsa', NULL, 'KSRTC-DVG-44129', 'Semi-Sleeper', '22',
 1, 260.00, 'Store IT Support and Point of Sale Upgrade', b.id, 'Same day emergency dispatch'
FROM employees e, employees b WHERE e.id = 4 AND b.id = 38
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

INSERT INTO travel_bookings (
  id, booking_reference, employee_id, location_id, transport_type, status,
  booking_date, booked_at, journey_date, journey_time,
  source_location, destination_location, boarding_point, dropping_point,
  operator_or_train_name, train_number, pnr_or_ticket_number, seat_class, seat_numbers,
  passenger_count, total_amount, purpose, booked_by_id, notes, cancellation_reason, cancelled_at, cancelled_by_id
)
SELECT 6, 'TRV-20261123-001', e.id, 2, 'bus', 'cancelled',
 '2026-11-23', '2026-11-23 14:10:00', '2026-11-24', '20:00:00',
 'Davanagere', 'Hubballi', 'KSRTC Bus Stand', 'Old Bus Stand Hubballi',
 'SRS Travels', NULL, 'SRS-55102', 'Non-AC Sleeper', 'U7',
 1, 450.00, 'Material Inspection', b.id, 'Supplier delayed dispatch date',
 'Supplier delayed fabric dispatch to next week', '2026-11-23 17:30:00', b.id
FROM employees e, employees b WHERE e.id = 5 AND b.id = 38
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- SHI Store Bookings
INSERT INTO travel_bookings (
  id, booking_reference, employee_id, location_id, transport_type, status,
  booking_date, booked_at, journey_date, journey_time,
  source_location, destination_location, boarding_point, dropping_point,
  operator_or_train_name, train_number, pnr_or_ticket_number, seat_class, seat_numbers,
  passenger_count, total_amount, purpose, booked_by_id, notes
)
SELECT 7, 'TRV-20261124-006', e.id, 3, 'bus', 'confirmed',
 '2026-11-24', '2026-11-24 10:00:00', '2026-11-25', '21:45:00',
 'Shivamogga', 'Bengaluru', 'Shivamogga KSRTC Depot', 'Majestic Bengaluru',
 'KSRTC Airavat', NULL, 'KSRTC-SMG-99321', 'AC Sleeper', '18',
 1, 1150.00, 'Regional Store Audit and HR Alignment', b.id, 'Booked via corporate travel portal'
FROM employees e, employees b WHERE e.id = 14 AND b.id = 39
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

INSERT INTO travel_bookings (
  id, booking_reference, employee_id, location_id, transport_type, status,
  booking_date, booked_at, journey_date, journey_time,
  source_location, destination_location, boarding_point, dropping_point,
  operator_or_train_name, train_number, pnr_or_ticket_number, seat_class, seat_numbers,
  passenger_count, total_amount, purpose, booked_by_id, notes
)
SELECT 8, 'TRV-20261124-007', e.id, 3, 'train', 'confirmed',
 '2026-11-24', '2026-11-24 11:45:00', '2026-11-26', '06:40:00',
 'Shivamogga', 'Davanagere', 'Shivamogga Town (SMET)', 'Davanagere (DVG)',
 'Talguppa InterCity Express', '16205', '412-8871239', 'Second Sitting (2S)', 'D3-54',
 1, 95.00, 'Logistics & Stock Transfer Handover', b.id, 'Confirmed express train booking'
FROM employees e, employees b WHERE e.id = 15 AND b.id = 39
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- Seed passengers for the bookings if bookings exist
INSERT INTO travel_passengers (booking_id, passenger_name, age, gender, seat_berth, ticket_number, status)
SELECT b.id, 'Shivanand Kulkarni', 38, 'male', 'Seat 14', 'KSRTC-BLG-88491-1', 'confirmed' FROM travel_bookings b WHERE b.id = 1
UNION ALL SELECT b.id, 'Sachin Desai', 34, 'male', 'Seat 15', 'KSRTC-BLG-88491-2', 'confirmed' FROM travel_bookings b WHERE b.id = 1
UNION ALL SELECT b.id, 'Sachin Desai', 34, 'male', 'C1-42', '425-9831045', 'confirmed' FROM travel_bookings b WHERE b.id = 2
UNION ALL SELECT b.id, 'Ganesh Patil', 29, 'male', 'L4', 'VRL-77312', 'waitlisted' FROM travel_bookings b WHERE b.id = 3
UNION ALL SELECT b.id, 'Ramesh Patil', 42, 'male', 'C2-18', '481-2245901-1', 'confirmed' FROM travel_bookings b WHERE b.id = 4
UNION ALL SELECT b.id, 'Suresh Kumar', 36, 'male', 'C2-19', '481-2245901-2', 'confirmed' FROM travel_bookings b WHERE b.id = 4
UNION ALL SELECT b.id, 'Suresh Kumar', 36, 'male', 'Seat 22', 'KSRTC-DVG-44129', 'confirmed' FROM travel_bookings b WHERE b.id = 5
UNION ALL SELECT b.id, 'Manjunath B', 31, 'male', 'U7', 'SRS-55102', 'cancelled' FROM travel_bookings b WHERE b.id = 6
UNION ALL SELECT b.id, 'Kiran Joshi', 35, 'male', 'Seat 18', 'KSRTC-SMG-99321', 'confirmed' FROM travel_bookings b WHERE b.id = 7
UNION ALL SELECT b.id, 'Harish Naik', 30, 'male', 'D3-54', '412-8871239', 'confirmed' FROM travel_bookings b WHERE b.id = 8
ON DUPLICATE KEY UPDATE created_at = CURRENT_TIMESTAMP;

-- Seed logs if bookings exist
INSERT INTO travel_booking_logs (booking_id, actor_id, action, previous_status, new_status, remarks)
SELECT b.id, 37, 'created', NULL, 'confirmed', 'Initial booking confirmed for Belagavi textile team' FROM travel_bookings b WHERE b.id = 1
UNION ALL SELECT b.id, 37, 'created', NULL, 'confirmed', 'Train ticket confirmed with PNR 425-9831045' FROM travel_bookings b WHERE b.id = 2
UNION ALL SELECT b.id, 37, 'created', NULL, 'pending', 'Submitted for manager journey confirmation' FROM travel_bookings b WHERE b.id = 3
UNION ALL SELECT b.id, 38, 'created', NULL, 'confirmed', 'Jan Shatabdi CC confirmed for Davanagere managers' FROM travel_bookings b WHERE b.id = 4
UNION ALL SELECT b.id, 38, 'created', NULL, 'confirmed', 'Rajahamsa seat 22 booked for urgent IT visit' FROM travel_bookings b WHERE b.id = 5
UNION ALL SELECT b.id, 38, 'created', NULL, 'confirmed', 'Initial booking created' FROM travel_bookings b WHERE b.id = 6
UNION ALL SELECT b.id, 38, 'status_changed', 'confirmed', 'cancelled', 'Cancelled due to vendor delivery postponement' FROM travel_bookings b WHERE b.id = 6
UNION ALL SELECT b.id, 39, 'created', NULL, 'confirmed', 'Confirmed KSRTC Airavat booking for Shivamogga audit' FROM travel_bookings b WHERE b.id = 7
UNION ALL SELECT b.id, 39, 'created', NULL, 'confirmed', 'Confirmed InterCity ticket to Davanagere' FROM travel_bookings b WHERE b.id = 8
ON DUPLICATE KEY UPDATE created_at = CURRENT_TIMESTAMP;
