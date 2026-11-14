ALTER TABLE projects
  ADD COLUMN conversation_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_projects_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE SET NULL;
