CREATE TABLE product_sync_settings (
  group_id TEXT PRIMARY KEY REFERENCES sync_groups(id) ON DELETE CASCADE,
  fields TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE product_sync_previews (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, source_id TEXT NOT NULL, snapshot TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE product_sync_jobs (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 1, lock_owner TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(group_id,source_id)
);
