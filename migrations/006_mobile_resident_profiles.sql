-- New mobile-only profile table. No existing admin-web tables, routes or records are changed.
CREATE TABLE IF NOT EXISTS mobile_resident_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mobile_resident_email_length CHECK(email IS NULL OR length(email) <= 200)
);
