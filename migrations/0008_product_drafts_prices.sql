ALTER TABLE product_sync_settings ADD COLUMN price_rules TEXT NOT NULL DEFAULT '{}';
ALTER TABLE product_sync_previews ADD COLUMN create_missing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_sync_previews ADD COLUMN lock_owner TEXT;
ALTER TABLE product_sync_previews ADD COLUMN lock_until INTEGER NOT NULL DEFAULT 0;
CREATE TABLE product_draft_creations (
  group_id TEXT NOT NULL REFERENCES sync_groups(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL, shop TEXT NOT NULL REFERENCES stores(shop) ON DELETE CASCADE,
  handle TEXT NOT NULL, product_id TEXT, attempted INTEGER NOT NULL DEFAULT 0,
  lock_owner TEXT, lock_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(group_id,source_id,shop)
);
