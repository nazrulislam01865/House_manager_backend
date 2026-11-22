-- Optional profile information and private Supabase Storage object references.
-- Existing finance / tenancy / authentication records are unchanged.
CREATE TABLE IF NOT EXISTS mobile_profile_details (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email text,
  present_address text,
  permanent_address text,
  emergency_contact text,
  occupation text,
  profile_image_path text,
  nid_image_path text,
  profile_image_updated_at timestamptz,
  nid_image_updated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mobile_profile_email_length CHECK (email IS NULL OR length(email) <= 200),
  CONSTRAINT mobile_profile_address_length CHECK (
    (present_address IS NULL OR length(present_address) <= 500) AND
    (permanent_address IS NULL OR length(permanent_address) <= 500)),
  CONSTRAINT mobile_profile_extra_length CHECK (
    (emergency_contact IS NULL OR length(emergency_contact) <= 40) AND
    (occupation IS NULL OR length(occupation) <= 120))
);
-- Carry forward existing resident email addresses without discarding them.
INSERT INTO mobile_profile_details(user_id,email)
SELECT user_id,email FROM mobile_resident_profiles WHERE email IS NOT NULL
ON CONFLICT(user_id) DO UPDATE SET email=COALESCE(mobile_profile_details.email,EXCLUDED.email);
