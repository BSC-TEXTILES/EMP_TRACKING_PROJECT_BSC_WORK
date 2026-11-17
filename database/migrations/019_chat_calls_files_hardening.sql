-- Chat deletion state, message idempotency and resumable upload sessions.
-- Additive only: existing rows and columns are preserved.

-- Per-user conversation state. Deleting a chat only updates this row for the
-- caller; messages, attachments and the other participant's copy are untouched.
CREATE TABLE IF NOT EXISTS conversation_user_state (
  conversation_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  deleted_at DATETIME(3) NULL,
  cleared_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (conversation_id, employee_id),
  KEY idx_conversation_user_state_employee (employee_id, deleted_at),
  CONSTRAINT fk_conversation_user_state_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_conversation_user_state_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Client-generated idempotency key. A retried send (network timeout, tab
-- restore, double click) returns the original message instead of inserting a
-- duplicate. NULL is allowed for messages created before this migration.
SET @has_client_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'client_id'
);
SET @sql := IF(@has_client_id = 0,
  'ALTER TABLE messages ADD COLUMN client_id VARCHAR(64) NULL AFTER reply_to_id',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_client_key := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND INDEX_NAME = 'uq_messages_client'
);
SET @sql := IF(@has_client_key = 0,
  'ALTER TABLE messages ADD UNIQUE KEY uq_messages_client (conversation_id, sender_id, client_id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Pagination uses (conversation_id, id) ordering; keep it indexed.
SET @has_page_index := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND INDEX_NAME = 'idx_messages_conversation_id'
);
SET @sql := IF(@has_page_index = 0,
  'ALTER TABLE messages ADD KEY idx_messages_conversation_id (conversation_id, id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- SHA-256 of the stored bytes, used as an integrity check and download ETag.
SET @has_files_sha := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'files' AND COLUMN_NAME = 'sha256'
);
SET @sql := IF(@has_files_sha = 0,
  'ALTER TABLE files ADD COLUMN sha256 CHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Resumable upload metadata. Chunk bytes are held in a private staging
-- directory and are only promoted to a registered `files` row on completion.
CREATE TABLE IF NOT EXISTS upload_sessions (
  id CHAR(36) NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(160) NOT NULL,
  expected_size BIGINT UNSIGNED NOT NULL,
  received_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  chunk_size INT UNSIGNED NOT NULL,
  total_chunks INT UNSIGNED NOT NULL,
  received_chunks TEXT NULL,
  status ENUM('uploading', 'completed', 'aborted', 'expired') NOT NULL DEFAULT 'uploading',
  sha256 CHAR(64) NULL,
  storage_key VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_upload_sessions_employee (employee_id, status, created_at),
  KEY idx_upload_sessions_expiry (expires_at, status),
  CONSTRAINT fk_upload_sessions_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
