-- Migration 027: Complete Email Functionality and History
-- Non-destructive additive updates to email_deliveries and internal_emails

-- 1. Extend email_deliveries to record sender_id, CC, BCC, content, attachments, and status
ALTER TABLE email_deliveries 
  MODIFY status ENUM('queued', 'sending', 'sent', 'accepted', 'failed', 'skipped', 'delivered') NOT NULL DEFAULT 'queued';

ALTER TABLE email_deliveries
  ADD COLUMN sender_id BIGINT UNSIGNED NULL AFTER id,
  ADD COLUMN cc_emails TEXT NULL AFTER recipient_name,
  ADD COLUMN bcc_emails TEXT NULL AFTER cc_emails,
  ADD COLUMN body_text MEDIUMTEXT NULL AFTER payload,
  ADD COLUMN body_html MEDIUMTEXT NULL AFTER body_text,
  ADD COLUMN attachments JSON NULL AFTER body_html;

CREATE INDEX idx_email_sender_created ON email_deliveries (sender_id, created_at);

-- 2. Extend internal_emails to support external recipients, CC, BCC, HTML body, and delivery tracking
ALTER TABLE internal_emails
  MODIFY recipient_id BIGINT UNSIGNED NULL;

ALTER TABLE internal_emails
  ADD COLUMN recipient_email VARCHAR(190) NULL AFTER recipient_id,
  ADD COLUMN recipient_name VARCHAR(150) NULL AFTER recipient_email,
  ADD COLUMN cc_emails TEXT NULL AFTER recipient_name,
  ADD COLUMN bcc_emails TEXT NULL AFTER cc_emails,
  ADD COLUMN body_html MEDIUMTEXT NULL AFTER body,
  ADD COLUMN delivery_status ENUM('queued', 'sending', 'accepted', 'failed', 'delivered') NOT NULL DEFAULT 'accepted' AFTER attachments,
  ADD COLUMN provider_message_id VARCHAR(190) NULL AFTER delivery_status,
  ADD COLUMN last_error VARCHAR(500) NULL AFTER provider_message_id;

CREATE INDEX idx_internal_emails_recipient_email ON internal_emails (recipient_email, created_at);
CREATE INDEX idx_internal_emails_delivery_status ON internal_emails (delivery_status);
