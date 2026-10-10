# OnlineSync review video

The English listing requires a screencast. Its form asks for a 3–8 minute demo linked through YouTube or a video file that opens without signing in; it excludes Google Drive and Vimeo. The video must show the actual app's onboarding and core inventory flow. This document is a recording script, not a finished video.

## Preparation

Use only development stores and test stock. For a fresh onboarding recording, use a fresh store group; the existing pilot group is already paired and established, so its pairing and initial-preview controls are intentionally disabled. Do not delete or reset the established group to pretend it is new. Existing private screenshots can supplement explanations, but cannot replace the onboarding demonstration.

Hide account menus, credentials, session tokens, CLI output and the Dev Console. Use a quiet microphone, legible text, and captions if narration is unavailable. No real customer or payment details should appear. The app has no storefront widget or customer login; the customer-facing effect is Shopify's available inventory.

## Suggested five-minute recording

| Time | Show | Explain |
| --- | --- | --- |
| 0:00–0:25 | OnlineSync App Home inside Shopify | “OnlineSync shares available inventory between Shopify stores you manage. One main store sets the starting quantity; later stock changes can come from either store.” |
| 0:25–1:15 | Install on each development store; create and redeem a pairing code | “Install the same app in both stores. The code connects the second store to the main store and expires after ten minutes.” |
| 1:15–1:55 | Select a stocked location in each store; prepare read-only preview | “Products match through unique SKUs. They must be tracked physical products with selling out of stock disabled. The preview shows what the first copy will do; preparing it does not change stock.” |
| 1:55–2:25 | Shopify Basic plan page and return to App Home | “Basic is USD 20 monthly with a seven-day trial. These development-store tests are free. The main store's subscription covers the connected group.” Do not imply development approval charges money. |
| 2:25–3:15 | Start syncing; show main starting quantity copied to second | Explain that the preview is checked again before copying and changes since the preview stop the affected SKU for review. |
| 3:15–4:00 | One free test order or one-unit stock reduction in each direction; refresh both stores | Show actual before/after quantities and recent activity. Label an inventory adjustment as an adjustment, and a test order as a test order. Do not edit away a failed result. |
| 4:00–4:40 | Pause, conflicting changes, blocked SKU, corrected recovery preview | “When both stores change before reconciliation, OnlineSync stops that SKU. Check stock and sales, correct the main quantity, prepare a fresh preview while paused, then resume.” |
| 4:40–5:00 | Shared stock, activity, help/privacy links | “This release synchronizes inventory. Product descriptions, images, prices and SEO are not included. Separate stores can sell before an update arrives, so a stock buffer may be appropriate.” |

## Before adding the video URL

Watch the entire final recording. Open its URL in a signed-out browser and confirm it plays without credentials. Verify every demonstrated action succeeds with the released configuration. Add that working URL to the listing's Screencast URL field and save. Do not use a placeholder link or submit the draft while other launch checks remain open.

## Current verified evidence

The two pilot stores have completed real free test orders in both directions, pause and conflict recovery, plus uninstall and reinstall of the second store. Reliability tests cover interrupted writes and lost responses; these are simulated failures, not a filmed Cloudflare outage. Catalog tests exercise three pages per store and enforce D1's 100-binding statement limit; a large real-store load test is still pending.
