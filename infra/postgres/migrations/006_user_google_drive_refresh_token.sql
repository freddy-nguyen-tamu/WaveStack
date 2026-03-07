ALTER TABLE app_users
ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;
