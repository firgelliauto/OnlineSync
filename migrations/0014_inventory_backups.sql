ALTER TABLE sync_groups ADD COLUMN inventory_restore_id TEXT;
CREATE TABLE inventory_restores (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
 shop TEXT NOT NULL, location_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'preview', lock_owner TEXT, lock_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX inventory_restores_group ON inventory_restores(group_id,created_at);
CREATE TABLE inventory_restore_items (
 restore_id TEXT NOT NULL REFERENCES inventory_restores(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL, sku TEXT NOT NULL, before_quantity INTEGER NOT NULL, target_quantity INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', error TEXT,
 PRIMARY KEY(restore_id,item_id)
);
