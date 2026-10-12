ALTER TABLE product_sync_settings ADD COLUMN inclusion TEXT NOT NULL DEFAULT '{}';
ALTER TABLE product_sync_jobs ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_sync_jobs ADD COLUMN requested_revision INTEGER;
