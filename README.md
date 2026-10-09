# OnlineSync

OnlineSync is a hosted, multi-merchant Shopify app for keeping inventory aligned across a merchant's stores. It starts with the main store's available quantity at a selected location. After activation, a stock change in any connected store changes the shared quantity and copies that value to the others. This follows the behavior of the private `M:/syncApp` project, while replacing its fixed two-store credentials and settings with merchant installs and store groups.

## Current state

The application is deployed to its own Cloudflare resources and is awaiting a new Shopify public app and development-store pilot. `INVENTORY_WRITES_ENABLED` is `false`; no Shopify inventory write can occur with the checked-in configuration. The old `M:/syncApp` deployment is separate and has not been changed.

OnlineSync hosting:

- Worker: `online-sync`, at `https://online-sync.firgelli-inventory-sync.workers.dev`
- D1 database: `online-sync` (`7845cdcd-7d1e-43e0-85da-88892820817b`)
- Queue: `online-sync-jobs`
- Token encryption key: stored as an OnlineSync Worker secret, with a local backup in ignored `.dev.vars`.

The URL suffix is the Cloudflare account's shared Workers subdomain. OnlineSync is a separate Worker; it does not bind to the original syncApp's state or resources. All five database migrations have been applied only to the new OnlineSync database.

Shopify account setup note: an unused development app named OnlineSync was created under the Firgelli merchant organization (`105534`, app `433756733441`). That organization does not expose public distribution. The app has no installations and its credentials have not been connected to Cloudflare. Do not use it for the public launch: the public app must be created under a Shopify Partner organization. No existing Shopify app was changed.

The actual public OnlineSync app is now created in the **Firgelli Test** Partner organization (Partner ID `1882822`, Dev Dashboard organization `129088346`). Its app ID is `433757585409`, client ID is `9f8d8ce3e71355bdf6f7137cdfe5738d`, and its app GID is `gid://shopify/App/433757585409`. Public distribution has been selected. The initial `development-pilot` version points to the OnlineSync Worker with only `read_products,read_inventory,write_inventory,read_locations` scopes. This does not mean the app has been submitted to or approved by the App Store. No stores have installed it yet.

The new public app's client ID and client secret are stored in ignored `.dev.vars` and in the `online-sync` Worker secrets. The existing encryption key was preserved. Shopify CLI is installed locally and authenticated. `shopify.app.toml` was imported from this app, then deployed as active version `pilot-webhooks-v1` (`1161770074113`) with inventory, uninstall, and mandatory privacy webhook subscriptions. No product-write scope is requested.

The Partner organization still needs Shopify App Store registration before app submission. Shopify's registration form asks for business type, associated developer accounts, and an attestation under the Partner Program Agreement; the account owner must complete that step. It is not required just to prepare the development-store pilot.

Two new Basic development stores were created solely for the OnlineSync pilot, with Shopify test-data generation selected:

- Main: `onlinesync-pilot-main.myshopify.com` (shop ID `100582523190`).
- Second: `onlinesync-pilot-second.myshopify.com` (shop ID `84546683135`).

These are separate from the existing FirgelliTest store and from all production stores. OnlineSync is installed through Shopify CLI development previews on both stores (`app dev --no-update` retained the hosted Worker URL). The previews remain after stopping CLI; use `app dev clean` to restore the released app configuration. Both stores are authenticated and paired, with Main as the main store and `Shop location` selected on each. The app's Shopify admin handle is `onlinesync-3`.

The sample Minimal Snowboard was assigned `ONLINESYNC-PILOT-001` on both stores. The first successful read-only preview found that SKU and Shopify's sample `sku-managed-1`, each showing main 50 and other 50. No inventory changed. Live installation/token exchange, location discovery, pairing, and catalog GraphQL reads are now verified. Billing setup and actual inventory propagation, including sales and retries, remain pending. The Worker write switch remains off.

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

The **new public Shopify app** is linked in `shopify.app.toml`. Do not reuse the client ID or credentials from `M:/syncApp`, which uses a different grant for two stores in one organization. Review configuration changes against OnlineSync's Dev Dashboard before pushing them with `npm run shopify -- app deploy`. Deploying app configuration does not deploy the Worker; use `npm run deploy` for that.

The Cloudflare D1 database and Queue are already created and bound in `wrangler.jsonc`. Apply future migrations remotely only after confirming the target account and OnlineSync database. The app's Cloudflare secrets are listed in `.env.example`; put local values in ignored `.dev.vars` and hosted values in the `online-sync` Worker secrets. Its 32-byte token encryption key has already been generated. Preserve that key when adding Shopify credentials. Never commit credentials or paste them into a public issue.

Configure a monthly plan in Shopify App Pricing and provide the Partner organization ID, Partner API access token, public app GID, and app handle as Worker secrets. The billing check fails closed: without these values, starting sync is unavailable. Keep `INVENTORY_WRITES_ENABLED=false` while testing installs, pairing, locations, preview, webhook signatures, billing, and subscription redirects. For a development-store pilot, turn it on only in the new OnlineSync Worker after reviewing the specific test stores and initial stock preview. This switch has no effect on the existing syncApp Worker.

## Verification and remaining work

`npm test` covers Shopify token and webhook verification, token encryption, one-use pairing, main and child sales, initial copy, webhook echoes, and simultaneous-change blocking. Database migrations and the Worker deployment have succeeded. The hosted health endpoint has been checked with inventory writes disabled. Shopify installation, billing, and inventory integration still require the new public app and development stores.

The next pilot should test install/uninstall/reinstall, subscription changes, token refresh, HMAC delivery, catalog sizes and rate limits, initial-copy interruption, simultaneous orders, inventory write retries, pause/resume, and privacy webhooks on development stores. Product descriptions, images, prices, and SEO fields should receive field-level sync rules and previews before being added to the live write path.

## Platform references

- [Shopify app authentication and token exchange](https://shopify.dev/docs/apps/build/authentication-authorization)
- [Expiring offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
- [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
- [Shopify inventory quantity mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities)
- [Mandatory privacy webhooks](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)
