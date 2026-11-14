CREATE TABLE IF NOT EXISTS session_refresh_tokens (
 token_hash CHAR(64) NOT NULL PRIMARY KEY,
 session_id BIGINT UNSIGNED NOT NULL,
 access_sid VARCHAR(128) NOT NULL,
 used_at DATETIME(3) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 KEY idx_refresh_session (session_id),
 CONSTRAINT fk_refresh_session FOREIGN KEY (session_id) REFERENCES employee_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
