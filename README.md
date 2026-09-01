# Meesho × ElasticRun — E2E Shipment Ops Dashboard (shared, hosted)

A tables-only, conditional-formatted logistics dashboard for the Meesho ↔
ElasticRun E2E flow, built from the "4500 shipment status report" export.
Unlike the earlier client-only versions of this tool, **this one is a real
hosted site**: one person uploads the report, and everyone who opens the
link sees the same numbers — the data lives server-side, not just in the
uploader's browser.

- `public/` — the static site (plain HTML/CSS/JS, no framework, no build step)
- `netlify/functions/` — two small serverless functions: `data.js` (read)
  and `upload.js` (password-gated write)
- `netlify.toml`, `package.json` — Netlify + dependency config
- `test/` — a local-only harness for testing the functions without a real
  Netlify account (not part of the deployed site)

**To deploy this for your team, follow [`DEPLOY.md`](./DEPLOY.md)** — it
covers pushing to GitHub, connecting Netlify, and the one environment
variable (the shared upload password) you need to add in Netlify's
dashboard.

## What each of the 10 tables shows

1. Pickup Efficiency — hours from Manifested to Picked-up, bucketed; defect = over 36h
2. Connections from FM % — picked-up shipments that have moved past the FM hub
3. Picked Up Pendency — picked-up shipments still stuck at FM
4. FDDS — first-day delivery success, split Prepaid/COD, by Last Mile station and delivery slot
5. Pickup → RAD Speed — days to reach the Last Mile station; defect = over 24h
6. Pickup → Customer Speed — days to actual delivery; defect = over 7 days (delivered late, or still pending)
7. ZRTO % — returned to origin with zero delivery attempts; defect = over 0.2% of total shipments
8. RTO % — returned to origin after a failed attempt; defect = over 15% of a station's own volume
9. Shipment Life Cycle — non-terminal shipments aging since Network Arrival, Forward vs Reverse (RTO), by Current Station
10. DWELL — non-terminal shipments stuck at their current station (excluding First Mile), by how long

Every table has a "Copy for email" button (copies a formatted, ready-to-paste
version to your clipboard) and double-click drill-down on flagged rows/cells
to see the underlying AWB numbers.
