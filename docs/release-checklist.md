# OnlineSync release checks

## Completed

- Optional draft creation and per-store price rules implemented with missing-product offers, explicit previews, unchanged existing variant identities, and recovery tests across two/three/four stores. Draft creation is excluded from automatic/catalog work. Live customer UI creation passed on the two pilot stores, including images, two variants, zero stock, calculated price/compare-at values, and subsequent automatic price-rule propagation. Automatic copying is off and rules reset to zero after testing.

- Separate Cloudflare Worker, D1 database, and Queue; original syncApp untouched.
- Public Shopify app configuration, minimum inventory scopes, signed inventory/uninstall/privacy webhooks.
- Two development-store installs, pairing, location selection and read-only baseline preview.
- Four-store support: pairing capacity, preview invalidation, initial copies, sales in all four directions, echoes, concurrent-change blocking, and paginated previews have automated coverage. A live four-store pilot still needs validation before launch.
- Main-store Shopify Basic test subscription and Partner API verification; Basic USD 14.99/month (up to 100 synchronized SKUs), Plus USD 24.99/month (101+); annual options save 20%; seven-day trial.
- Initial stock copy, changes from either store, and actual free development-store orders in both directions.
- Pause, conflicting-change blocking, durable recovery preview, baseline recovery and echo checks.
- Real second-store uninstall: token deletion and group pause. Reinstall: fresh encrypted credentials and retained mapping. Manual resume and subsequent 41-to-40 propagation passed.
- Real main-store refresh: forced local expiry marker, successful Shopify refresh, renewed access/refresh expiry and released refresh lock.
- Automated interruption/lost-response cases, including a sale during recovery and a stale planned write.
- Automated paginated catalog preview with 260 variants per store, duplicate exclusion and D1 binding limits.
- Authenticated SKU search and paging, with tenant-isolation and literal-search checks.
- Public help/privacy pages; listing copy, icon and screenshots saved.

## Required before submission

- Validate a live three/four-store group and larger multi-variant product galleries, product catalog scans and throttling. Update listing screenshots and the review recording to include optional product fields.

- Record actual onboarding, subscription and inventory behavior; upload the 3–8 minute screencast to an accessible supported destination. Script: `listing/review-video.md`. The listing currently reports this as its sole missing field.
- Exercise a larger real catalog and Shopify throttling; the automated catalog fixture is not a load-test result.
- Verify subscription cancellation/plan changes pause stock work and a renewed subscription permits a deliberate resume.
- Arrange reviewer store access to inventory writes. The current pilot allowlist blocks every store except the two named development stores. Do not submit a review flow that cannot be activated.
- Confirm the intended publisher profile: app branding is Firgelliauto; the shared Partner organization still displays Firgelli Test. Confirm actual business-profile information before publication.
- Establish operational monitoring and a support routine for failed jobs and blocked stock.
- Review the final recording, listing and release configuration, then submit to Shopify review.

## Deployment scope

Use only `wrangler.jsonc` in this repo: Worker `online-sync`, database ID `7845cdcd-7d1e-43e0-85da-88892820817b`, Queue `online-sync-jobs`. Preserve its encryption key. Inventory writes are enabled only for `onlinesync-pilot-main.myshopify.com` and `onlinesync-pilot-second.myshopify.com`. Public activation requires a deliberate change to the write allowlist after launch checks.

Optional product syncing now supports eleven independently selected fields, guarded previews and automatic main-store webhook copies. Product writes share the exact two-store pilot allowlist and require PRODUCT_WRITES_ENABLED. Product permission grants, price-only isolation, all eleven fields including images/options, real webhook/queue propagation and unchanged inventory were verified on both pilot stores; products were restored and automatic product copying left off.
