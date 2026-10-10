# Private developer dashboard

URL: https://online-sync-admin.firgelli-inventory-sync.workers.dev

Sign in with `ndavey97@gmail.com` using the Cloudflare Access email code. Sessions last 24 hours. This separate Worker is not part of the merchant UI.

The overview shows subscribed production groups, trials, connected stores, successful writes over 24 hours, and a seven-day UTC activity chart. Development stores are excluded from subscriber totals. One group is one subscription. The collapsed customer section searches all groups by main or connected store domain, using literal matching and 50-row paging. Clicking a group opens a private detail URL with connection state, billing state, pending work, inventory-block counts, the latest 50 activity events, and the latest 30 recorded incidents. Raw event detail, SKU lists, and credentials are omitted.

## Cloudflare usage

The panel reads Cloudflare GraphQL Analytics using the separate `OnlineSync usage dashboard` account token, with only Account Analytics Read permission. Its value is stored only as `CLOUDFLARE_ANALYTICS_TOKEN` on `online-sync-admin`, with a local backup in ignored `.wrangler/cloudflare-analytics-token`. It is never sent to the browser. The token has no write permissions and no expiration; rotation or revocation is done in Cloudflare Account API tokens.

Workers Free was verified in account subscriptions on October 9, 2026. The panel shows today's UTC Worker requests, D1 rows read/written, queue billable operations, and database storage. OnlineSync counters filter to its two Workers, its database ID, and its queue ID; account counters aggregate all resources without displaying other app details. Allowances are shared across the account. Progress bars use account totals, warn at 80%, and turn red at 95%. Counters are cached for five minutes per Worker isolate and may lag or use sampling. Failed metrics show unavailable, never zero.

The plan and allowance configuration is a verified reference, not automatic billing-plan detection. Update `CLOUDFLARE_PLAN` and its verification date if the account upgrades. Paid mode uses calendar-month counters and included allowances, not a hard spending cap or an invoice. Storage uses the maximum observed size over the last day per database, summed for the account.

References: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/), [Queue metrics](https://developers.cloudflare.com/queues/observability/metrics/), [analytics token permissions](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/).

Subscription status is a verified snapshot, not proof of collected revenue. Snapshots older than 24 hours are unknown and excluded from totals. The five-minute sweep refreshes up to ten oldest snapshots over an hour old, including paused groups. Use Shopify Partner earnings for revenue.

## Security and deployment

`wrangler.admin.jsonc` targets only `online-sync-admin` and the OnlineSync database. It has no Shopify credentials, inventory-write code, or queue bindings. Routes are GET-only. Analytics access is read-only and account-scoped. Read-only database behavior is enforced by the code, not a separate D1 permission role.

Cloudflare Access application `OnlineSync Developer` (`56fd8e6b-51d2-4374-bb7f-be2a597ebd24`) protects only this Worker's production and preview URLs. Its sole Allow policy, `OnlineSync owner only`, specifies the exact owner email. The runtime also verifies the JWT signature, issuer, audience, expiry, and email before any database read. Missing settings fail closed. Issuer and audience are public verification metadata, not credentials.

Deploy with `npm run admin:deploy`; deploy the merchant app with `npm run deploy`. Changing the owner requires updating both the Access policy and `ADMIN_EMAIL`. Do not protect `online-sync` with this policy: Shopify merchants and webhooks need its existing authentication flow. Never modify the old syncApp resources.

## Diagnostics

Unresolved app, webhook, billing, scheduler, and sync failures appear as standardized categories/codes, occurrence counts, timestamps, and suggested actions. Raw error payloads are not saved in the incident table. Repeated failures update one incident; success resolves it. Resolved incidents are pruned after 30 days. Merchant-associated incidents follow existing privacy deletion through foreign keys.

The dashboard also flags groups with blocked inventory matches, overdue jobs, and a recovery scheduler with no successful sweep in over 20 minutes. It refreshes once a minute while visible. Overview lists are bounded to 20 incidents and 20 blocked groups; customer search is paginated separately. Platform outages that prevent Worker or database execution cannot always record an incident; unavailable data is shown explicitly, with Cloudflare logs linked.

Automated coverage checks signed-token failures, denied requests making no database reads, subscriber classification, SKU/credential omission, incident resolution, bounded billing refresh, customer search/pagination, group-detail isolation, and Cloudflare counter aggregation/caching/failures. Live checks verified the read-only analytics token, the connected-store search, and pilot-group detail data.
