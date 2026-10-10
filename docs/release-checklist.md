# OnlineSync release checks

## Completed

- Separate Cloudflare Worker, D1 database, and Queue; original syncApp untouched.
- Public Shopify app configuration, minimum inventory scopes, signed inventory/uninstall/privacy webhooks.
- Two development-store installs, pairing, location selection and read-only baseline preview.
- Main-store Shopify Basic test subscription and Partner API verification; USD 20 monthly, seven-day trial.
- Initial stock copy, changes from either store, and actual free development-store orders in both directions.
- Pause, conflicting-change blocking, durable recovery preview, baseline recovery and echo checks.
- Real second-store uninstall: token deletion and group pause. Reinstall: fresh encrypted credentials and retained mapping. Manual resume and subsequent 41-to-40 propagation passed.
- Real main-store refresh: forced local expiry marker, successful Shopify refresh, renewed access/refresh expiry and released refresh lock.
- Automated interruption/lost-response cases, including a sale during recovery and a stale planned write.
- Automated paginated catalog preview with 260 variants per store, duplicate exclusion and D1 binding limits.
- Authenticated SKU search and paging, with tenant-isolation and literal-search checks.
- Public help/privacy pages; listing copy, icon and screenshots saved.

## Required before submission

- Record actual onboarding, subscription and inventory behavior; upload the 3–8 minute screencast to an accessible supported destination. Script: `listing/review-video.md`. The listing currently reports this as its sole missing field.
- Exercise a larger real catalog and Shopify throttling; the automated catalog fixture is not a load-test result.
- Verify subscription cancellation/plan changes pause stock work and a renewed subscription permits a deliberate resume.
- Arrange reviewer store access to inventory writes. The current pilot allowlist blocks every store except the two named development stores. Do not submit a review flow that cannot be activated.
- Confirm the intended publisher profile: app branding is Firgelliauto; the shared Partner organization still displays Firgelli Test. Confirm actual business-profile information before publication.
- Establish operational monitoring and a support routine for failed jobs and blocked stock.
- Review the final recording, listing and release configuration, then submit to Shopify review.

## Deployment scope

Use only `wrangler.jsonc` in this repo: Worker `online-sync`, database ID `7845cdcd-7d1e-43e0-85da-88892820817b`, Queue `online-sync-jobs`. Preserve its encryption key. Inventory writes are enabled only for `onlinesync-pilot-main.myshopify.com` and `onlinesync-pilot-second.myshopify.com`. Public activation requires a deliberate change to the write allowlist after launch checks.

The inventory release does not synchronize product descriptions, photos, prices or SEO. Those need field-level previews and product-write permissions before implementation and release.
