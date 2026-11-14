-- Verification codes must never remain in delivery logs or be queued for later replay.
UPDATE email_deliveries SET payload = NULL, max_attempts = 1 WHERE template = 'otp';
