# Private developer dashboard

URL: https://online-sync-admin.firgelli-inventory-sync.workers.dev

Sign in with `ndavey97@gmail.com` using the Cloudflare Access email code. Sessions last 24 hours. This separate Worker is not part of the merchant UI.

The overview shows subscribed production groups, trials, connected stores, successful writes over 24 hours, and a seven-day UTC activity chart. Development stores are excluded from subscriber totals. One group is one subscription. A collapsed group summary supports troubleshooting without customer SKU lists or credentials.

Subscription status is a verified snapshot, not proof of collected revenue. Snapshots older than 24 hours are unknown and excluded from totals. The five-minute sweep refreshes up to ten oldest snapshots over an hour old, including paused groups. Use Shopify Partner earnings for revenue.

## Security and deployment

`wrangler.admin.jsonc` targets only `online-sync-admin` and the OnlineSync database. It has no Shopify credentials, inventory-write code, or queue bindings. Routes are GET-only. Read-only behavior is enforced by the code, not a separate D1 permission role.

Cloudflare Access application `OnlineSync Developer` (`56fd8e6b-51d2-4374-bb7f-be2a597ebd24`) protects only this Worker's production and preview URLs. Its sole Allow policy, `OnlineSync owner only`, specifies the exact owner email. The runtime also verifies the JWT signature, issuer, audience, expiry, and email before any database read. Missing settings fail closed. Issuer and audience are public verification metadata, not credentials.

Deploy with `npm run admin:deploy`; deploy the merchant app with `npm run deploy`. Changing the owner requires updating both the Access policy and `ADMIN_EMAIL`. Do not protect `online-sync` with this policy: Shopify merchants and webhooks need its existing authentication flow. Never modify the old syncApp resources.

## Diagnostics

Unresolved app, webhook, billing, scheduler, and sync failures appear as standardized categories/codes, occurrence counts, timestamps, and suggested actions. Raw error payloads are not saved in the incident table. Repeated failures update one incident; success resolves it. Resolved incidents are pruned after 30 days. Merchant-associated incidents follow existing privacy deletion through foreign keys.

The dashboard also flags groups with blocked inventory matches, overdue jobs, and a recovery scheduler with no successful sweep in over 20 minutes. It refreshes once a minute while visible. Detailed lists are bounded to 20 incidents, 20 blocked groups, and 50 recent customer groups. Platform outages that prevent Worker or database execution cannot always record an incident; unavailable data is shown explicitly, with Cloudflare logs linked.

Automated coverage checks signed-token failures, denied requests making no database reads, subscriber classification, SKU/credential omission, incident resolution, and bounded billing refresh with per-group failure isolation. A local layout preview uses fixture data only.
