-- Add identity details without rewriting existing accounts or finance records.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nid text;
ALTER TABLE users ADD CONSTRAINT users_nid_format CHECK (nid IS NULL OR nid ~ '^([0-9]{10}|[0-9]{13}|[0-9]{17})$');
ALTER TABLE users ADD CONSTRAINT users_username_role CHECK (username IS NULL OR role = 'ADMIN');
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (lower(username)) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_org_nid_unique ON users (organization_id,nid) WHERE nid IS NOT NULL;
CREATE TABLE IF NOT EXISTS app_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx ON app_sessions(expires_at);
CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON app_sessions(user_id);
