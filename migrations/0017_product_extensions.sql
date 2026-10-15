ALTER TABLE product_sync_settings ADD COLUMN match_by TEXT NOT NULL DEFAULT 'sku';
ALTER TABLE product_sync_settings ADD COLUMN creation_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_sync_settings ADD COLUMN metafield_keys TEXT NOT NULL DEFAULT '[]';
CREATE TABLE product_restores (
 id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
 shop TEXT NOT NULL,snapshot TEXT NOT NULL,created_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'preview',lock_owner TEXT,lock_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE product_restore_items (
 restore_id TEXT NOT NULL REFERENCES product_restores(id) ON DELETE CASCADE,
 product_id TEXT NOT NULL,before_snapshot TEXT NOT NULL,backup_snapshot TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',detail TEXT,
 PRIMARY KEY(restore_id,product_id)
);
CREATE INDEX product_restores_group_status ON product_restores(group_id,status);
CREATE INDEX product_restore_items_work ON product_restore_items(restore_id,status);
