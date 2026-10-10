# OnlineSync

OnlineSync is a hosted, multi-merchant Shopify app for keeping inventory aligned across a merchant's stores. It starts with the main store's available quantity at a selected location. After activation, a stock change in any connected store changes the shared quantity and copies that value to the others. This follows the behavior of the private `M:/syncApp` project, while replacing its fixed two-store credentials and settings with merchant installs and store groups.

## Current state

The application is deployed to its own Cloudflare resources and linked to a new Shopify public app. Installation, authentication, pairing, locations, billing, two-store sales, conflict recovery, and uninstall/reinstall have been verified on two isolated development stores. `INVENTORY_WRITES_ENABLED` is `true`, with the allowlist restricting writes to those two stores. Public merchant writes remain disabled. The old `M:/syncApp` deployment is separate and has not been changed.

OnlineSync hosting:

- Worker: `online-sync`, at `https://online-sync.firgelli-inventory-sync.workers.dev`
- D1 database: `online-sync` (`7845cdcd-7d1e-43e0-85da-88892820817b`)
- Queue: `online-sync-jobs`
- Token encryption key: stored as an OnlineSync Worker secret, with a local backup in ignored `.dev.vars`.

The URL suffix is the Cloudflare account's shared Workers subdomain. OnlineSync is a separate Worker; it does not bind to the original syncApp's state or resources. All six database migrations have been applied only to the new OnlineSync database.

A separate private developer dashboard is at `https://online-sync-admin.firgelli-inventory-sync.workers.dev`. It summarizes subscriptions, activity, incidents, and recovery health without customer SKU lists. See [the dashboard runbook](docs/developer-dashboard.md).

Shopify account setup note: an unused development app named OnlineSync was created under the Firgelli merchant organization (`105534`, app `433756733441`). That organization does not expose public distribution. The app has no installations and its credentials have not been connected to Cloudflare. Do not use it for the public launch: the public app must be created under a Shopify Partner organization. No existing Shopify app was changed.

The actual public OnlineSync app is now created in the **Firgelli Test** Partner organization (Partner ID `1882822`, Dev Dashboard organization `129088346`). Its app ID is `433757585409`, client ID is `9f8d8ce3e71355bdf6f7137cdfe5738d`, and its app GID is `gid://shopify/App/433757585409`. Public distribution has been selected. The app points to the OnlineSync Worker with only `read_products,read_inventory,write_inventory,read_locations` scopes. Two development stores have installed it. It has not been submitted to or approved by the App Store.

The new public app's client ID and client secret are stored in ignored `.dev.vars` and in the `online-sync` Worker secrets. The existing encryption key was preserved. Shopify CLI is installed locally and authenticated. `shopify.app.toml` was imported from this app, then deployed as active version `pilot-webhooks-v1` (`1161770074113`) with inventory, uninstall, and mandatory privacy webhook subscriptions. No product-write scope is requested.

The account owner completed Shopify App Store registration on October 9, 2026, and the Partner Dashboard confirms registration succeeded. The draft listing's primary language is English. The inventory app declares no customer-data use; it requests no customer or order scopes. **Basic: USD 20 monthly with a 7-day free trial** is saved in Shopify App Pricing with handle `basic`, redirect `/`, and free development-store testing enabled. There are no usage charges. The invoice name and internal plan handle cannot be changed after creation; the pricing and trial inputs remain editable.

The English listing draft is saved, including the Basic display name, category, introduction, feature copy, screenshots, support email, and public help/privacy URLs. Shopify has picked up the Dev Dashboard icon and now reports one missing draft field: the required screencast URL. A five-minute recording script is in `docs/listing/review-video.md`; no video has been recorded or uploaded. The draft has not been submitted for review.

OnlineSync's business name is **Firgelliauto** and its public support email is **nathan@firgelliauto.com**. The shared Partner organization settings have not been renamed. `/help` and `/privacy` are public pages hosted by the separate OnlineSync Worker.

The owner approved a new Partner API client, **OnlineSync billing checks** (39117), with only Manage apps permission. Its token is in ignored local configuration and the online-sync Worker secret. Shopify scopes that permission across the Partner organization; this app uses only its own app GID in subscription queries. A real Partner API query confirmed the main development store's active Basic test subscription. The hosted Shopify approval page explicitly stated that this test plan is free and will not be billed.

Two new Basic development stores were created solely for the OnlineSync pilot, with Shopify test-data generation selected:

- Main: `onlinesync-pilot-main.myshopify.com` (shop ID `100582523190`).
- Second: `onlinesync-pilot-second.myshopify.com` (shop ID `84546683135`).

These are separate from the existing FirgelliTest store and from all production stores. OnlineSync is installed through Shopify CLI development previews on both stores (`app dev --no-update` retained the hosted Worker URL). The previews remain after stopping CLI; use `app dev clean` to restore the released app configuration. Both stores are authenticated and paired, with Main as the main store and `Shop location` selected on each. The app's Shopify admin handle is `onlinesync-3`.

The sample Minimal Snowboard was assigned `ONLINESYNC-PILOT-001` on both stores. The first successful read-only preview found that SKU and Shopify's sample `sku-managed-1`, each showing main 50 and other 50. Live installation/token exchange, location discovery, pairing, catalog reads, subscription approval, and Partner API checks are verified. The live pilot then copied the second store from 43 to the main baseline of 50. A child adjustment to 47 reached the main store; a main adjustment to 45 reached the child. Shopify webhook delivery and echoed writes were verified. Free development-store orders were then created in both directions: a main-store sale moved both stores from 45 to 44, and a second-store sale moved both from 44 to 43. No payments were collected. Pause kept quantities independent; resuming after changes in both stores blocked the SKU without a write. A read-only recovery preview staged main 41 and second 42 with a proposed shared baseline of 41, survived a page reload, and left stock unchanged. Resuming applied the baseline and both stores reached 41. Uninstalling the second store then cleared its credentials and paused the group. Reinstalling restored its connection without automatically resuming stock writes. After manual resume, a second-store adjustment from 41 to 40 reached the main store. Marking the main pilot token as expired exercised a real Shopify refresh and restored valid encrypted access and refresh tokens with the lock released. Interrupted writes and catalog pagination have automated coverage; real load testing and review-video capture remain pending.

Implemented:

- Embedded Shopify App Home using App Bridge ID tokens, verified on every API request.
- Expiring offline token exchange, encrypted storage, refresh rotation, and a per-store refresh lock.
- Merchant store groups, one-use pairing codes, location selection, and a read-only SKU preview.
- Unique-SKU matching for tracked, physical products that do not continue selling out of stock.
- A main-store initial quantity, followed by changes from either store. Ambiguous concurrent changes block that SKU. The main store can pause, stage a fresh recovery preview, and resume with a corrected main-store baseline. Recovery checks the job lock and group membership; changed quantities block again rather than overwriting stale stock.
- Stock reads recheck SKU uniqueness, tracking, physical shipping, and out-of-stock selling before writes. Pairing cannot add a new store to an established inventory group.
- Idempotent Shopify inventory writes with a current-quantity check, webhook deduplication, queue retries, a five-minute sweep, and daily reconciliation.
- Shopify App Pricing subscription checks through the Partner API. Starting sync requires an active subscription, an explicit deployment write switch, and a permitted store group.
- Authenticated uninstall and mandatory privacy webhook handlers.

This is not ready for App Store submission yet. Remaining launch work includes a review recording, real catalog load/rate-limit checks, subscription-change integration, monitoring, and reviewer access. Product-content sync is a later feature requiring separate field rules and permission changes. The write switch is enabled only for the two named development stores through INVENTORY_WRITE_ALLOWED_SHOPS. An empty allowlist denies all writes; public merchant writes require an explicit wildcard and a separate launch decision.

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
- `src/conflicts.mjs`: paused, read-only recovery previews for blocked SKUs.
- `src/write-policy.mjs`: deployment switch and pilot shop allowlist.
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

Configure a monthly plan in Shopify App Pricing and provide the Partner organization ID, Partner API access token, public app GID, and app handle as Worker secrets. The billing check fails closed: without these values, starting sync is unavailable. Keep `INVENTORY_WRITES_ENABLED=false` for read-only setup. The current write pilot is restricted to the two named development stores by `INVENTORY_WRITE_ALLOWED_SHOPS`. For a development-store pilot, turn it on only in the new OnlineSync Worker after reviewing the specific test stores and initial stock preview. This switch has no effect on the existing syncApp Worker.

## Verification and remaining work

`npm test` currently passes 37 tests covering Shopify token and webhook verification, token encryption, one-use pairing, initial copy, main and child sales, echoed writes, simultaneous-change blocking, recovery previews, changed inventory policies, pilot isolation, deleted queue jobs, uninstall, and store redaction. Failure-injection checks verify that interrupted writes reuse their original idempotency key, a lost response does not replay a stock change, and a sale during recovery receives a fresh reconciliation. A 260-variant, three-page-per-store preview verifies duplicate detection across pages and D1's 100-bound-parameter limit. Database migrations and the Worker deployment have succeeded. Live installation, billing approval, two-store sale propagation, pause, conflict detection, recovery, and second-store uninstall/reinstall have been verified on the named development stores. Public merchant writes remain disabled by the pilot allowlist.

Remaining integration work includes subscription changes, real catalog load and rate limits, controlled network interruption, and simultaneous-order timing. Token refresh, uninstall/reinstall, HMAC delivery, pause/resume, and two-store propagation have passed on the development stores; privacy deletion and retry failure cases have automated coverage. Product descriptions, images, prices, and SEO fields should receive field-level sync rules and previews before being added to the live write path.

## Platform references

- [Shopify app authentication and token exchange](https://shopify.dev/docs/apps/build/authentication-authorization)
- [Expiring offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
- [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
- [Shopify inventory quantity mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities)
- [Mandatory privacy webhooks](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)

## Restricted pilot inventory check

`node scripts/pilot-inventory.mjs main` (or `second`) reads the real stock for ONLINESYNC-PILOT-001. `--set quantity` performs a guarded test adjustment of at most five units. The helper accepts only the two named development-store domains, checks the exact OnlineSync database ID, honors the write policy, and reads encrypted tokens without displaying them. It cannot accept another store or database. Reopen the app first if its access token needs refreshing.

Worker console diagnostics are enabled for OnlineSync. Invocation logging is disabled to avoid retaining embedded app URLs containing short-lived session tokens. The dashboard shows recorded shared quantities, pending updates, and review state, with SKU search and 30-row paging scoped to the authenticated store group. The inventory endpoint has pagination, literal-search, authentication, and tenant-isolation coverage. Actual review-video capture remains launch work. Retry failure tests use simulated Shopify responses; they do not claim to demonstrate a real platform outage.
