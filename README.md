# OnlineSync

OnlineSync is a hosted, multi-merchant Shopify app for keeping inventory aligned across a merchant's stores. It starts with the main store's available quantity at a selected location. After activation, a stock change in any connected store changes the shared quantity and copies that value to the others. This follows the behavior of the private `M:/syncApp` project, while replacing its fixed two-store credentials and settings with merchant installs and store groups.

## Current state

The application code is ready for a **development-store pilot**, but it has not been connected to a new Shopify public app, a Cloudflare account, or live stores. `INVENTORY_WRITES_ENABLED` defaults to `false`; no Shopify inventory write can occur with the checked-in configuration. The old `M:/syncApp` deployment is separate and has not been changed.

Implemented:

- Embedded Shopify App Home using App Bridge ID tokens, verified on every API request.
- Expiring offline token exchange, encrypted storage, refresh rotation, and a per-store refresh lock.
- Merchant store groups, one-use pairing codes, location selection, and a read-only SKU preview.
- Unique-SKU matching for tracked, physical products that do not continue selling out of stock.
- A main-store initial quantity, followed by changes from either store. Ambiguous concurrent changes block that SKU.
- Idempotent Shopify inventory writes with a current-quantity check, webhook deduplication, queue retries, a five-minute sweep, and daily reconciliation.
- Shopify App Pricing subscription checks through the Partner API. Starting sync requires an active subscription and an explicit deployment write switch.
- Authenticated uninstall and mandatory privacy webhook handlers.

This is not ready for App Store submission yet. The next work is an end-to-end pilot on two development stores, conflict-resolution controls, support/privacy pages, product-content sync rules, operational monitoring, and Shopify review. The live switch should only be enabled after the pilot is reviewed.

## How a merchant uses it

1. Install the same public OnlineSync app in the main store and each additional store.
2. Open the app in the main store, create a pairing code, and enter it in each additional store. Each code works once and expires after ten minutes.
3. Choose an active inventory location from each store.
4. Prepare a read-only matching preview. Unique matching SKUs are staged with the main store's quantity as the starting shared quantity.
5. Choose a Shopify-hosted subscription plan. Starting sync requires the main store to have an active plan.
6. Start syncing. Before an initial copy, the worker checks whether any previewed quantity has changed. If it has, that SKU is blocked for review. Otherwise, it copies the main quantity to the other stores.
7. Later webhooks queue a fresh check. A change in one store adjusts the shared quantity and updates the other stores. If several stores changed before reconciliation, that SKU is blocked because the worker cannot safely tell independent sales from a second sync app.

Even with webhooks and queues, sales can happen in separate stores before the new quantity arrives. Merchants who cannot tolerate overselling should use a stock buffer. The exact inventory location and SKU mapping must be reviewed before activation.

## Architecture

- `src/worker.mjs`: App Home, authenticated API, webhooks, queue consumer, and scheduled reconciliation.
- `src/security.mjs`: Shopify ID token and webhook HMAC verification; AES-GCM token encryption.
- `src/shopify.mjs`: public-app token exchange and refresh; GraphQL Admin API access.
- `src/catalog.mjs`: read-only product-variant discovery and exact SKU matching.
- `src/pairing.mjs`: short-lived store pairing.
- `src/billing.mjs`: Shopify App Pricing active-subscription check.
- `src/inventory.mjs` and `src/sync-plan.mjs`: shared quantity planning and guarded writes.
- `migrations/`: D1 schema for store groups, catalog links, activity, jobs, and pending writes.

Cloudflare Workers serves the app and receives webhooks. D1 holds merchant configuration and sync state. Cloudflare Queues runs stock work; scheduled Worker events recover missed jobs and reconcile daily. Shopify hosts storefronts and bills merchants for the app.

## Development setup

Node 24 or later is required. Install dependencies and run the local checks:

```powershell
npm install
npm test
npm run db:local
npx wrangler deploy --dry-run
```

Create a **new public Shopify app** in the Dev Dashboard. Do not reuse the client ID or credentials from `M:/syncApp`, which uses a different grant for two stores in one organization. Copy `shopify.app.example.toml` to `shopify.app.toml` and fill in that new app's client ID and the Cloudflare Worker URL. The exact TOML must be reviewed against the new app's Dev Dashboard before it is pushed to Shopify.

Create a Cloudflare D1 database called `online-sync` and a Queue called `online-sync-jobs`. Replace the placeholder `database_id` in `wrangler.jsonc` with the real D1 ID. Apply migrations remotely only after confirming the target account and database. The app's Cloudflare secrets are listed in `.env.example`; put local values in ignored `.dev.vars` and hosted values in Cloudflare Worker secrets. Generate a fresh 32-byte base64 `TOKEN_ENCRYPTION_KEY`. Never commit credentials or paste them into a public issue.

Configure a monthly plan in Shopify App Pricing and provide the Partner organization ID, Partner API access token, public app GID, and app handle as Worker secrets. The billing check fails closed: without these values, starting sync is unavailable. Keep `INVENTORY_WRITES_ENABLED=false` while testing installs, pairing, locations, preview, webhook signatures, billing, and subscription redirects. For a development-store pilot, turn it on only in the new OnlineSync Worker after reviewing the specific test stores and initial stock preview. This switch has no effect on the existing syncApp Worker.

## Verification and remaining work

`npm test` covers Shopify token and webhook verification, token encryption, one-use pairing, main and child sales, initial copy, webhook echoes, and simultaneous-change blocking. `wrangler d1 migrations apply --local` and `wrangler deploy --dry-run` validate the database and Worker bundle. No real Shopify or Cloudflare integration has been tested because the new public app and hosted resources are not connected yet.

The next pilot should test install/uninstall/reinstall, subscription changes, token refresh, HMAC delivery, catalog sizes and rate limits, initial-copy interruption, simultaneous orders, inventory write retries, pause/resume, and privacy webhooks on development stores. Product descriptions, images, prices, and SEO fields should receive field-level sync rules and previews before being added to the live write path.

## Platform references

- [Shopify app authentication and token exchange](https://shopify.dev/docs/apps/build/authentication-authorization)
- [Expiring offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
- [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
- [Shopify inventory quantity mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities)
- [Mandatory privacy webhooks](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)
