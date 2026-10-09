ALTER TABLE stores ADD COLUMN refresh_lock TEXT;
ALTER TABLE stores ADD COLUMN refresh_lock_expires_at INTEGER NOT NULL DEFAULT 0;
