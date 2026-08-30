# basketmint-congress-ingest

Scheduled parser that turns House **Periodic Transaction Report** PDFs (STOCK Act disclosures) into a small
`congress_house.json` the Basket Mint terminal reads. Runs entirely on GitHub Actions — no server, no cost.

## How it works
- `ingest_house_ptr.mjs` fetches the House Clerk bulk index, downloads recent PTR PDFs, extracts text with
  pdf.js, and parses stock transactions with `parse_ptr.mjs`.
- The workflow (`.github/workflows/ingest.yml`) runs every 6h and commits `congress_house.json`.
- The Basket Mint Cloudflare Function reads it via the `HOUSE_JSON_URL` env var:
  `https://raw.githubusercontent.com/<you>/<repo>/main/congress_house.json`

## One-time setup
1. Settings → Actions → General → Workflow permissions → **Read and write** → Save.
2. Actions tab → **ingest** → **Run workflow** (first run; then it's automatic).
3. In Cloudflare Pages → your project → Settings → Environment variables, set `HOUSE_JSON_URL` to the raw URL above.
