-- Transactional email queue, delivery log and SMTP observability.
-- Every outbound message is recorded here so administrators can inspect
-- delivery status without ever seeing SMTP credentials.

CREATE TABLE IF NOT EXISTS email_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recipient_email VARCHAR(190) NOT NULL,
  recipient_name VARCHAR(150) NULL,
  subject VARCHAR(255) NOT NULL,
  template VARCHAR(60) NOT NULL,
  payload JSON NULL,
  status ENUM('queued', 'sending', 'sent', 'failed', 'skipped') NOT NULL DEFAULT 'queued',
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 3,
  next_attempt_at DATETIME(3) NULL,
  last_error VARCHAR(500) NULL,
  message_id VARCHAR(190) NULL,
  related_type VARCHAR(40) NULL,
  related_id BIGINT UNSIGNED NULL,
  dedupe_key VARCHAR(160) NULL,
  sent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_dedupe (dedupe_key),
  KEY idx_email_status_due (status, next_attempt_at),
  KEY idx_email_recipient (recipient_email),
  KEY idx_email_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
