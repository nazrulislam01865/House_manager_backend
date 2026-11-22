-- At most one active mobile access token per account. Keep the newest session
-- when upgrading databases which previously permitted multiple devices.
DELETE FROM app_sessions old
USING app_sessions newer
WHERE old.user_id = newer.user_id
  AND (old.created_at < newer.created_at
       OR (old.created_at = newer.created_at AND old.id < newer.id));
CREATE UNIQUE INDEX IF NOT EXISTS app_sessions_one_per_user_idx
  ON app_sessions(user_id);
