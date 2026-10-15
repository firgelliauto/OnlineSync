# Product extensions and one-way inventory

Implemented October 14, 2026. Deployment scope: OnlineSync only; original SyncApp resources are untouched. Public writes remain restricted to the three development stores.

## Merchant features

- Product matching by unique SKU or barcode. Barcode matching retains each store’s existing SKUs. New drafts retain the selected matching identity.
- Optional category, cost, taxable status, weight, country of origin, HS code and portable product metafields, alongside existing content, image, option and pricing fields.
- Select product metafields by namespace.key; an empty selection copies supported merchant-owned values. Reference types, app-owned fields and variant metafields are not copied. Target-only metafields are retained. Compare-and-set guards concurrent metafield edits.
- Creation-only copying creates eligible missing destination products as unpublished drafts and leaves all existing products unchanged. It does not mean historical source products can never be copied: the policy concerns destination creation.
- Signed JSON product backups from a selected store; reviewed restore to a selected connected store. Same-store restores use Shopify IDs, cross-store restores use the selected SKU/barcode method. All changed products have expandable field differences. Automatic product copying must be Off; remains Off after restoration. No quantities, orders, publications, translations, theme files, product deletions or new products are restored.
- Backup limits: 1,000 products / 15 MB, 250 variants and media items per product, 100 product metafields. Shopify source image files must remain available. A download is a snapshot across its duration, not a transaction across the catalog.
- One-way Inventory is a separate Shopify navigation entry and reuses the automatic SKU, include/exclude, manual mapping, collection/tag, safety net, inventory backup, export and activity sections. Each mode now has independent saved rules, On/Off switches and safety net settings (October 14 update). Only one mode runs at a time for a group. Switching pauses and waits for pending updates before activation.
- One-way mode treats the main quantity as authoritative. Child-store sales do not reduce the main stock and can be overwritten. Intended for an upstream inventory system that already accounts for those sales. Shared stock remains the appropriate mode for a stock pool sold in every store.
- Existing manual mappings still require all group members. Arbitrary product participation in a subset of stores is not implemented by this release.

## Verification

Automated tests cover identifier ambiguity, draft creation and recovery, portable metafield inputs/concurrency, signed backup validation, same-store blank-SKU restoration and post-preview conflicts, one-way destination correction and main-store restocking, generated browser scripts and existing inventory rules.

Live three-store tests verified barcode matches with different SKUs; category, cost, tax, weight, origin, HS code and custom.material copying; a downloaded backup restoring a deliberately changed test title without inventory writes; destination sales being corrected in one-way mode without reducing main stock; main restocking propagating; real creation webhooks producing drafts in both destination stores with subsequent edits left unchanged. A same-store preview reviewed 20 products including blank SKUs without skips. Browser backup download completed for 21 products. Browser file chooser automation timed out; the upload/review/restore API round trip was verified directly using the original signed download.

The pilot was restored to its original Active shared-stock mode and product preferences. Test drafts remain unpublished for further verification.
