# OnlineSync

OnlineSync is a hosted, multi-merchant Shopify app for keeping inventory aligned across a merchant's stores. It starts with the main store's available quantity at a selected location. After activation, a stock change in any connected store changes the shared quantity and copies that value to the others. This follows the behavior of the private `M:/syncApp` project, while replacing its fixed two-store credentials and settings with merchant installs and store groups.

## Current state

Home includes a collapsible setup guide with separate Inventory Synchronization (five tasks) and optional Product Synchronization (three tasks) categories. Each category progress bar shows X/Y tasks completed; the optional workflows have no combined completion count. Inventory progress reflects stores, locations, matching stock, subscription and active status; product progress reflects saved fields, recorded successful copies and automatic copying settings. Each expandable task links to the relevant controls. Inventory automatic matching uses separate On/Off buttons. The inventory page has three configuration sections. Pause and optional stock previews are embedded in automatic matching; Home keeps subscription and store setup. Include/exclude SKU lists use bounded scroll panels with optional vertical resizing. Manual SKU mappings stay in a fixed-height, keyboard-accessible scroll panel, with case-insensitive search across both SKUs and store names. Search hides rows without removing them from saved settings.

Automatic matching, include rules, exclusions and manual mappings have independent switches. Each switch saves only its own setting and ignores unsaved form edits. Disabled sections retain their saved entries and are greyed out. Enabled exclusions win over other rules; explicit mappings reserve their destination inventory items ahead of automatic same-SKU matches. Entries autosave independently. Edits pause active inventory syncing. Clicking On saves the section and starts or resumes inventory automatically; no manual preview is required. First activation validates connected stores, locations, billing and eligible matches, then stages the main-store baseline under the configuration lock. Incomplete mapping rows stay local until both stores and SKUs are entered. Failed autosaves show an error and a Retry autosave control.

The application is deployed to its own Cloudflare resources and linked to a new Shopify public app. Installation, authentication, pairing, locations, billing, two-store sales, conflict recovery, and uninstall/reinstall have been verified on two isolated development stores. `INVENTORY_WRITES_ENABLED` is `true`, with the allowlist restricting writes to those two stores. Public merchant writes remain disabled. The old `M:/syncApp` deployment is separate and has not been changed.

OnlineSync hosting:

- Worker: `online-sync`, at `https://online-sync.firgelli-inventory-sync.workers.dev`
- D1 database: `online-sync` (`7845cdcd-7d1e-43e0-85da-88892820817b`)
- Queue: `online-sync-jobs`
- Token encryption key: stored as an OnlineSync Worker secret, with a local backup in ignored `.dev.vars`.

The URL suffix is the Cloudflare account's shared Workers subdomain. OnlineSync is a separate Worker; it does not bind to the original syncApp's state or resources. All eight database migrations have been applied only to the new OnlineSync database.

A separate private developer dashboard is at `https://online-sync-admin.firgelli-inventory-sync.workers.dev`. It summarizes subscriptions, activity, incidents, and recovery health without customer SKU lists. See [the dashboard runbook](docs/developer-dashboard.md).

Shopify account setup note: an unused development app named OnlineSync was created under the Firgelli merchant organization (`105534`, app `433756733441`). That organization does not expose public distribution. The app has no installations and its credentials have not been connected to Cloudflare. Do not use it for the public launch: the public app must be created under a Shopify Partner organization. No existing Shopify app was changed.

The actual public OnlineSync app is now created in the **Firgelli Test** Partner organization (Partner ID `1882822`, Dev Dashboard organization `129088346`). Its app ID is `433757585409`, client ID is `9f8d8ce3e71355bdf6f7137cdfe5738d`, and its app GID is `gid://shopify/App/433757585409`. Public distribution has been selected. The app points to the OnlineSync Worker with required `read_products,read_inventory,write_inventory,read_locations` scopes and optional `write_products,read_files` access for product copying. Three development stores have installed it. It has not been submitted to or approved by the App Store.

The new public app's client ID and client secret are stored in ignored `.dev.vars` and in the `online-sync` Worker secrets. The existing encryption key was preserved. Shopify CLI is installed locally and authenticated. `shopify.app.toml` was imported from this app, then deployed with inventory, product create/update, uninstall, and mandatory privacy webhook subscriptions. Product access is requested separately in each store when the merchant chooses product syncing.

The account owner completed Shopify App Store registration on October 9, 2026, and the Partner Dashboard confirms registration succeeded. The draft listing's primary language is English. The inventory app declares no customer-data use; it requests no customer or order scopes. **Basic: USD 20 monthly or USD 192 annually (20% off), with a 7-day trial** is saved in Shopify App Pricing with handle `basic`, redirect `/`, and free development-store testing enabled. There are no usage charges. The invoice name and internal plan handle cannot be changed after creation; the pricing and trial inputs remain editable.

The English listing draft is saved, including the Basic display name, category, introduction, feature copy, screenshots, support email, and public help/privacy URLs. Shopify has picked up the Dev Dashboard icon and now reports one missing draft field: the required screencast URL. A five-minute recording script is in `docs/listing/review-video.md`; no video has been recorded or uploaded. The draft has not been submitted for review.

OnlineSync's business name is **Firgelliauto** and its public support email is **nathan@firgelliauto.com**. The shared Partner organization settings have not been renamed. `/help` and `/privacy` are public pages hosted by the separate OnlineSync Worker.

The owner approved a new Partner API client, **OnlineSync billing checks** (39117), with only Manage apps permission. Its token is in ignored local configuration and the online-sync Worker secret. Shopify scopes that permission across the Partner organization; this app uses only its own app GID in subscription queries. A real Partner API query confirmed the main development store's active Basic test subscription. The hosted Shopify approval page explicitly stated that this test plan is free and will not be billed.

Three Basic development stores were created solely for the OnlineSync pilot. Main and Second used Shopify test-data generation; Third started empty:

- Main: `onlinesync-pilot-main.myshopify.com` (shop ID `100582523190`).
- Second: `onlinesync-pilot-second.myshopify.com` (shop ID `84546683135`).
- Third: `onlinesync-pilot-third.myshopify.com`, an empty Basic development store created for the 20-SKU inventory pilot.

These are separate from the existing FirgelliTest store and from all production stores. OnlineSync is installed through Shopify CLI development previews on both stores (`app dev --no-update` retained the hosted Worker URL). The old development previews were cleaned on both pilot stores; they now use the released app configuration. Both stores are authenticated and paired, with Main as the main store and `Shop location` selected on each. The app's Shopify admin handle is `onlinesync-3`.

The sample Minimal Snowboard was assigned `ONLINESYNC-PILOT-001` on both stores. The first successful read-only preview found that SKU and Shopify's sample `sku-managed-1`, each showing main 50 and other 50. Live installation/token exchange, location discovery, pairing, catalog reads, subscription approval, and Partner API checks are verified. The live pilot then copied the second store from 43 to the main baseline of 50. A child adjustment to 47 reached the main store; a main adjustment to 45 reached the child. Shopify webhook delivery and echoed writes were verified. Free development-store orders were then created in both directions: a main-store sale moved both stores from 45 to 44, and a second-store sale moved both from 44 to 43. No payments were collected. Pause kept quantities independent; resuming after changes in both stores blocked the SKU without a write. A read-only recovery preview staged main 41 and second 42 with a proposed shared baseline of 41, survived a page reload, and left stock unchanged. Resuming applied the baseline and both stores reached 41. Uninstalling the second store then cleared its credentials and paused the group. Reinstalling restored its connection without automatically resuming stock writes. After manual resume, a second-store adjustment from 41 to 40 reached the main store. Marking the main pilot token as expired exercised a real Shopify refresh and restored valid encrypted access and refresh tokens with the lock released. Interrupted writes and catalog pagination have automated coverage; real load testing and review-video capture remain pending.

Implemented:

- Automatic same-SKU inventory matching switch followed by typed Include SKU / Exclude SKU tabs. Off allows only include rules and manual mappings; exclusions always win. Earlier tag/collection filters remain available for existing groups until explicitly cleared. Changes require a paused, idle group and a fresh reviewed baseline; saving never changes Shopify quantities. The automatic shared-stock list is removed from the customer page.
- Explicit Store A / SKU A / Store B / SKU B inventory mappings. Either side can be any group member, including reversed main-store mappings and child-to-child chains. Mapping components must resolve to one main-store SKU and at most one variant per store; ambiguous identities and collisions with automatic matches stop the preview. Shopify SKU identities remain unchanged; product-content copying keeps its separate matching rules.
- Group-scoped CSV activity export on Inventory syncing and Product syncing, with cursor pagination, retained SKU history and spreadsheet formula protection. Exports include the recorded history within the 90-day retention period.
- Optional missing-product drafts through explicit reviewed previews. Only wholly absent SKU sets qualify; partial matches stop. New products are DRAFT with zero copied stock, required title/SKUs/options plus selected fields. Durable creation receipts and locks recover committed responses without repeating writes. Automatic/catalog updates never create products. Gift cards and bundles are excluded.
- Shopify sidebar navigation exposes Inventory syncing and Product syncing beneath OnlineSync; clicking the app name opens Home. Uses Shopify App Bridge app navigation.
- Customer pages: Home for setup, subscription and inventory controls; Inventory syncing for automatic matching, SKU rules, previews, recovery and inventory activity; Product syncing for field selections, price rules, previews and product activity. Navigation preserves unsaved choices, supports browser back/forward and direct page reloads. Disabled controls retain the hand cursor.
- Editable store names shared across each group, used in customer activity, previews and price rules. The main store can rename all members; connected stores can rename themselves. Names never change Shopify identities or stock settings.
- Price rules per connected store: percentage then fixed adjustment, currency precision, nearest whole amount or rounding upward to .99. Compare-at adjustment is separately optional. Rules respect field choices and matching currencies; changed rules invalidate old previews.

- Product checkboxes for title, description, images/alt text, price, compare-at price, vendor, product type, tags, SEO, variant option names/values and barcode. Only selected fields copy main → connected stores. Unique complete SKU sets must match; cross-currency price copying is blocked.
- Read-only product previews expire after twenty minutes and reject changed products, settings or group membership. Optional product access, active billing and the exact pilot allowlist guard writes. Durable product jobs, retries, catalog scans and incident reporting support automatic main-store product updates; child updates do not echo.
- Product URLs, SKU identities, inventory, publication, collections and metafields remain local. Image galleries replace images while preserving local videos; deterministic filenames reuse uploaded files after interruptions. Products above 250 variants or media items require review.

- Embedded Shopify App Home using App Bridge ID tokens, verified on every API request.
- Expiring offline token exchange, encrypted storage, refresh rotation, and a per-store refresh lock.
- Merchant store groups, one-use pairing codes, location selection, and a read-only SKU preview.
- Unique-SKU matching for tracked, physical products that do not continue selling out of stock.
- A main-store initial quantity, followed by changes from any connected store. Ambiguous concurrent changes block that SKU. The main store can pause, stage a fresh recovery preview, and resume with a corrected main-store baseline. Recovery checks the job lock and group membership; changed quantities block again rather than overwriting stale stock.
- Stock reads recheck SKU uniqueness, tracking, physical shipping, and out-of-stock selling before writes. Pairing cannot add a new store to an established inventory group.
- Idempotent Shopify inventory writes with a current-quantity check, webhook deduplication, queue retries, a five-minute sweep, and daily reconciliation.
- Shopify App Pricing subscription checks through the Partner API. Starting sync requires an active subscription, an explicit deployment write switch, and a permitted store group.
- Authenticated uninstall and mandatory privacy webhook handlers.

This is not ready for App Store submission yet. Remaining launch work includes a review recording, real catalog load/rate-limit checks, subscription-change integration, monitoring, and reviewer access. Selected product-content syncing is implemented; automatic copying defaults off. The write switch is enabled only for the three named development stores through INVENTORY_WRITE_ALLOWED_SHOPS. An empty allowlist denies all writes; public merchant writes require an explicit wildcard and a separate launch decision.

## How a merchant uses it

1. Install the same public OnlineSync app in the main store and each additional store.
2. Open the app in the main store, create a pairing code, and enter it in each additional store. Each code works once and expires after ten minutes.
3. Choose an active inventory location from each store.
4. Check the main store’s starting stock. An optional read-only preview can show matches, but activation prepares them automatically.
5. Choose a Shopify-hosted subscription plan. Starting sync requires the main store to have an active plan.
6. Click On on Inventory syncing. Before an initial copy, the worker checks whether any previewed quantity has changed. If it has, that SKU is blocked for review. Otherwise, it copies the main quantity to the other stores.
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

Configure a monthly plan in Shopify App Pricing and provide the Partner organization ID, Partner API access token, public app GID, and app handle as Worker secrets. The billing check fails closed: without these values, starting sync is unavailable. Keep `INVENTORY_WRITES_ENABLED=false` for read-only setup. The current write pilot is restricted to the three named development stores by `INVENTORY_WRITE_ALLOWED_SHOPS`. For a development-store pilot, turn it on only in the new OnlineSync Worker after reviewing the specific test stores and initial stock preview. This switch has no effect on the existing syncApp Worker.

## Verification and remaining work

The subsequent inventory-page revision removes the automatic shared-stock list, adds typed include/exclude SKU tabs and an automatic matching switch, and makes both mapping stores explicit. The live pilot was saved with 20 explicit include SKUs and 15 reversed or child-to-child mappings. The new read-only preview matched all 20 SKUs across three stores with equal quantities, and the group resumed with no baseline change. Automated coverage includes automatic matching off, mapping-only live updates, exclusion precedence, reversed mappings, connected-store chains, invalid store selections and ambiguous identity rejection.

The October 10, 2026 three-store inventory pilot passed with 20 selected SKUs and 15 manual aliases. Separate unpublished 21-variant drafts were created in each OnlineSync development store. A tag selection plus an excluded control SKU produced exactly 20 inventory links and 60 store members. The main baseline of 101–120 copied to both peers. One-unit stock decrements were then simulated through Shopify's inventory API on all 20 SKUs, first in Main, then Second, then Third, waiting for convergence between stores. Real Shopify webhooks and Cloudflare Queues propagated all 60 decrements; the final shared quantities were 98–117 in every store. These were inventory-adjustment simulations, not new checkout orders. The excluded control retained its independent quantities of 121/41/51, and both original pilot SKUs remained at 40/50 in the original two stores. Real collection membership and live eligibility reads also passed. The customer CSV control reported a successful download; the final inventory export endpoint contained 499 recorded events, including the mapped SKUs.

This pilot exposed the Cloudflare per-invocation subrequest limit when several stock jobs shared one queue invocation. The OnlineSync consumer now uses a batch size of one. Pending jobs recovered without repeated stock changes, the second and third store runs completed, and no operational issues remained open. Public merchant writes remain disabled. The three-store test group is left active using only the new pilot drafts.

The draft-and-price pilot created an unpublished two-variant product through the embedded customer UI on October 10, 2026. Main prices 10/20 with +10%, +2 and upward .99 rounding produced child prices 13.99/24.99; compare-at prices became 18.99/35.99. Both variants retained zero stock and the original stock pilot stayed unchanged. A real main-store price update to 12 propagated automatically as 15.99, then was restored to 10/13.99. Automatic product copying was switched off and saved rules reset to zero afterward. The isolated draft products remain unpublished for review.

`npm test` currently passes 87 tests covering Shopify token and webhook verification, token encryption, one-use pairing, initial copy, main and child sales, echoed writes, simultaneous-change blocking, recovery previews, changed inventory policies, pilot isolation, deleted queue jobs, uninstall, and store redaction. Failure-injection checks verify that interrupted writes reuse their original idempotency key, a lost response does not replay a stock change, and a sale during recovery receives a fresh reconciliation. A 260-variant, three-page-per-store preview verifies duplicate detection across pages and D1's 100-bound-parameter limit. Database migrations and the Worker deployment have succeeded. Live installation, billing approval, two-store sale propagation, pause, conflict detection, recovery, and second-store uninstall/reinstall have been verified on the named development stores. Public merchant writes remain disabled by the pilot allowlist.

Remaining integration work includes subscription changes, real catalog load and rate limits, controlled network interruption, and simultaneous-order timing. Token refresh, uninstall/reinstall, HMAC delivery, pause/resume, and two-store propagation have passed on the development stores; privacy deletion and retry failure cases have automated coverage. Product field previews, price-only isolation, all eleven selected fields, image copying, option changes, and real automatic webhook/queue propagation have passed on the two pilot stores. Inventory remained unchanged during these tests, and original pilot products were restored.

## Platform references

- [Shopify app authentication and token exchange](https://shopify.dev/docs/apps/build/authentication-authorization)
- [Expiring offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
- [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
- [Shopify inventory quantity mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities)
- [Mandatory privacy webhooks](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)

## Restricted pilot inventory check

`node scripts/pilot-inventory.mjs main` (or `second`) reads the real stock for ONLINESYNC-PILOT-001. `--set quantity` performs a guarded test adjustment of at most five units. The helper accepts only the two named development-store domains, checks the exact OnlineSync database ID, honors the write policy, and reads encrypted tokens without displaying them. It cannot accept another store or database. Reopen the app first if its access token needs refreshing.

Worker console diagnostics are enabled for OnlineSync. Invocation logging is disabled to avoid retaining embedded app URLs containing short-lived session tokens. The dashboard shows recorded shared quantities, pending updates, and review state, with SKU search and 30-row paging scoped to the authenticated store group. The inventory endpoint has pagination, literal-search, authentication, and tenant-isolation coverage. Actual review-video capture remains launch work. Retry failure tests use simulated Shopify responses; they do not claim to demonstrate a real platform outage.

Store groups support up to four Shopify stores (one main and three additional stores) under the main store's subscription. Pair each additional store with a separate code before starting the initial sync. Group capacity is enforced within the pairing transaction, including outstanding codes. Adding a store during setup clears any previous stock preview. Automated four-store checks cover initial copies, sales originating from every store, copy echoes, concurrent-change blocking, and a 260-variant preview with D1 binding limits. The live allowlist contains the three named OnlineSync pilot stores; a four-store live pilot remains a release check.

Inventory activation no longer requires a merchant-prepared stock preview. A live check began with zero links and no completed preview, then clicked On in the installed main-store app. OnlineSync automatically prepared and initialized 20 SKUs across all three pilot stores, with zero blocked SKUs. All stock quantities still agreed, and the excluded SKU remained at independent quantities 121 / 41 / 51. The optional preview and explicit conflict recovery remain available.

Inventory section switches sit directly below their titles. Off dims all content below the switch, including instructions, and disables that section's inputs. Include and exclude tabs expose their respective independent switches in the same top position. The active inventory notification and separate start/resume button have been removed; activation remains available through On.

Off inventory sections block mouse and keyboard interaction through inert child content and an input overlay. Wheel and touch scrolling are cancelled over the disabled body, list scrollbars and resize handles are hidden, and every disabled element uses the standard arrow cursor. On/Off switches and SKU tabs remain available outside the disabled body.

Inventory safety net is opt-in per group. Sync now independently queues all active matches; repeated requests are limited to once per minute. Scheduled reconciliation at 03:07 and 15:07 UTC queues only enabled, active groups, replacing the prior unconditional daily sweep. Durable jobs and bounded dispatch use the existing recovery scheduler and inventory reconciliation safeguards, preserving exclusions, mappings, billing, pilot write limits, paused groups and blocked conflicts. Last requested time records queueing rather than claiming completion. All 20 SKUs across three stores passed a no-change manual check in integration tests.

The Plan page (/plan) shows freshly verified subscription details, main-store billing ownership and synchronized SKU usage. Basic supports up to 100 synchronized SKUs at $14.99 USD/month or $143.90 USD/year; Plus supports 101+ at $24.99 USD/month or $239.90 USD/year. Both Shopify App Pricing plans have a seven-day trial, 20% annual discount rounded to cents, and free development-store testing. The native Shopify title bar has an Upgrade action opening Plan. Additional installed stores pair on Home without purchasing another plan. The searchable FAQ has 79 answers across seven topics.

SKU admission is serialized per group and counted from a union of inventory and product enrollment. Duplicate SKUs across stores and across synchronization types count once. Basic refuses the 101st SKU before writes; a downgrade while over limit pauses inventory and blocks product writes. Changes never create an automatic billing upgrade. Reservations are retained on ambiguous or partial product failures; clearing product fields or rebuilding inventory selections releases their corresponding enrollment. Existing paused enrollments remain counted. Apply migration 0013 before deploying. References: https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing and https://shopify.dev/docs/api/app-home/latest/app-bridge-web-components/title-bar.

Inventory Backup sits between Safety net and Activity export. Downloads capture tracked variants’ available quantities at one connected store’s configured location, regardless of inventory inclusion rules. Signed versioned JSON is bound to the group, store and location; edited files and imports from other groups are rejected. A separate Restore to selector chooses any installed store in the group at its configured inventory location. Same-store restores use stable item IDs; cross-store restores use unique SKUs and enabled manual mappings (including chains). Explicit destination mappings take priority over automatic matching. Blank, missing, duplicate and ambiguous cross-store matches are skipped, as are collisions where two backup items target one destination item. Preview displays source, destination, aliases and skipped reasons. Changing the destination or file invalidates the old preview. Capture is paginated and not an atomic snapshot. Current limits are 5,000 captured variants, 10,000 scanned variants and 3 MB imports. The existing token encryption key signs backups; preserve it so existing downloads remain verifiable.

Import previews are read-only and expire after 24 hours. Restore requires the main store, paused inventory, an active subscription, an installed matching location and the existing pilot write allowlist. Durable batches restore ten variants per request, use idempotency keys and compare-and-set quantities, and can be continued after network uncertainty. Deleted or changed variants are skipped; subsequent quantity conflicts are recorded. A restore prevents group changes until completion or cancellation. Affected shared-stock links are blocked before external writes and need recovery review; synchronization stays paused. Cancellation retains completed writes. Backups themselves are kept by the customer; D1 stores only restore plans and activity records. Apply migration 0014 before deployment. Shopify mutation reference: https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities.

Validation: 93 automated checks passed, covering SKU boundaries, union counting, cached Plus development entitlement, signed import validation, quantity conflicts, paused-only restore, interrupted idempotent retry and cancellation. Live pilot download captured 47 tracked variants; read-only import found all 47 unchanged, with group settings and stock preserved. Browser automation verified the native Upgrade action, plan details and backup controls; the in-app browser file-chooser event could not be captured, so file-picker interaction still needs manual verification.

Cross-store restoration validation: 96 automated checks passed, including destination-only writes using its inventory item IDs and location, explicit mapping priority and chains, duplicate rejection and many-to-one collision protection. Live Main-to-Second preview matched 20 variants (19 unchanged and one proposed update), skipped 27 blank or unmatched entries, and preserved all stock and synchronization settings. Browser verification confirmed independent Download from and Restore to selectors.

Product inclusion rules are independent of field/price settings and autosave on the Product Synchronization page. Tags, product types and main-store collections form an OR selection; an optional required ready tag is ANDed with that selection. A ready tag alone selects products carrying it; enabled rules with no criteria select nothing. Disabled rules preserve entries and remove filtering. All manual previews, reviewed draft creation, catalog runs and webhook jobs enforce current inclusion. Synchronize now queues a revision-bound manual catalog run even when automatic product copying is Off; later edits cancel stale manual jobs. It updates existing products only, using saved fields and the existing permissions, billing, SKU limits and pilot write allowlist. Apply migration 0015 before deploying.

Inventory collection and tag sections have independent switches and autosaved entries. Collection selection uses main-store membership and matches variants by SKU across peers; collections need not share IDs or names. For a source carrying a configured inventory tag, at least one same configured tag must appear on every peer product, including mapped variants. Missing peer tags suppress preview matches and block live writes; untagged products can still match through other enabled sections. Exclusions remain highest priority. Legacy inclusion flags migrate logically without discarding entries. Empty tag/collection sections can be enabled for editing without requiring a stock preview or starting an empty synchronization. After adding entries, select On to apply them.

Every inventory section now uses the Automatic inventory synchronization by … title pattern. Saving feedback appears beside the relevant switch outside its dimmed body, as well as near the top of the page. Product inclusion and product-settings saves also show immediate progress. Off sections retain their interaction and scrolling guards. Validation: 101 checks passed, including readiness gating, collection membership, stale manual-job cancellation, manual copying with automatic Off, shared-tag matching, and loss of a peer tag during live inventory work. Live UI verified tag autosave, saving feedback, collection lookup and a no-match manual request; the temporary product rule was removed and prior settings restored.
