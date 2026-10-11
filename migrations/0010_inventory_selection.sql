ALTER TABLE sync_groups ADD COLUMN inventory_config_lock TEXT;
ALTER TABLE sync_groups ADD COLUMN inventory_config_lock_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_members ADD COLUMN mapped_sku TEXT;
ALTER TABLE sync_events ADD COLUMN sku TEXT;
CREATE TABLE inventory_settings (
  group_id TEXT PRIMARY KEY REFERENCES sync_groups(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
