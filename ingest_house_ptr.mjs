// Scheduled INGEST for House Periodic Transaction Reports (PTRs).
//
// pdf.js is a ~2MB engine and each PTR PDF takes real CPU to parse, so this does NOT run inside the edge
// Function on the request path. It runs on a schedule (GitHub Action cron — see
// .github/workflows/ingest-congress.yml), where it CAN reach house.gov, and writes a small JSON that the
// /api/congress Function reads. Committing the JSON auto-deploys via Cloudflare Pages.
//
// Flow: bulk index ZIP -> recent PTR filings -> download each PDF -> pdf.js text -> parsePtrText -> rows.
//   - Stock ([ST]) transactions become ticker-level rows {t, act, amt}.
//   - Filings with no parsed stock trade (bonds/T-bills/options, or unparseable newer PDFs) still emit a
//     filing-level row {t:null, url} so House presence is never dropped.
//
//   Run:  node scripts/ingest_house_ptr.mjs [year] [maxPtrs] > webapp/congress_house.json
//   Deps: pdfjs-dist (npm i pdfjs-dist). Node 18+ (global fetch, DecompressionStream, zlib).

import zlib from "node:zlib";
import { parsePtrText, iso } from "./parse_ptr.mjs";

const UA = "Basket Mint Terminal (https://basketmint.trade) admin@basketmint.trade";
const YEAR = +(process.argv[2] || new Date().getUTCFullYear());
const MAX_PTRS = +(process.argv[3] || 80);

// ---- minimal ZIP reader (sync, Node zlib) ----
function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function unzipEntry(buf, wantName) {
  const b = new Uint8Array(buf);
  let eo = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 22 - 65536; i--) { if (u32(b, i) === 0x06054b50) { eo = i; break; } }
  if (eo < 0) throw new Error("zip: no EOCD");
  let cd = u32(b, eo + 16); const n = u16(b, eo + 10);
  for (let i = 0; i < n; i++) {
    if (u32(b, cd) !== 0x02014b50) break;
    const method = u16(b, cd + 10), csize = u32(b, cd + 20), nameLen = u16(b, cd + 28), extraLen = u16(b, cd + 30), commentLen = u16(b, cd + 32), lho = u32(b, cd + 42);
    const name = Buffer.from(b.subarray(cd + 46, cd + 46 + nameLen)).toString("latin1");
    cd += 46 + nameLen + extraLen + commentLen;
    if (name !== wantName) continue;
    const lNameLen = u16(b, lho + 26), lExtraLen = u16(b, lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const data = Buffer.from(b.subarray(start, start + csize));
    return method === 0 ? data : zlib.inflateRawSync(data);
  }
  throw new Error(`zip: ${wantName} not found`);
}

async function houseIndex(year) {
  const r = await fetch(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`house zip ${r.status}`);
  const txt = unzipEntry(await r.arrayBuffer(), `${year}FD.txt`).toString("latin1");
  const lines = txt.split(/\r?\n/); const head = lines[0].split("\t");
  const idx = (n) => head.findIndex((h) => h.trim().toLowerCase() === n);
  const iLast = idx("last"), iType = idx("filingtype"), iState = idx("statedst"), iDate = idx("filingdate"), iDoc = idx("docid");
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t"); if (c.length < head.length) continue;
    if ((c[iType] || "").trim() !== "P") continue;
    const doc = (c[iDoc] || "").trim(); if (!doc) continue;
    out.push({ last: (c[iLast] || "").trim(), state: (c[iState] || "").trim().slice(0, 2), date: (c[iDate] || "").trim(), doc });
  }
  out.sort((a, z) => (iso(a.date) < iso(z.date) ? 1 : -1));
  return out;
}

// ---- pdf.js text extraction (lazy import so `node --check` works without the dep installed) ----
let _pdfjs;
async function pdfText(bytes) {
  if (!_pdfjs) {
    _pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    try { _pdfjs.GlobalWorkerOptions.workerSrc = (await import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).replace?.("file://", "") || ""; } catch (_) {}
  }
  const doc = await _pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  let all = [];
  for (let p = 1; p <= doc.numPages; p++) { const pg = await doc.getPage(p); const tc = await pg.getTextContent(); all.push(tc.items.map((i) => i.str).join(" ")); }
  try { await doc.destroy(); } catch (_) {}
  return all.join(" ");
}

async function main() {
  const filings = (await houseIndex(YEAR)).slice(0, MAX_PTRS);
  const rows = [];
  for (const f of filings) {
    const url = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${YEAR}/${f.doc}.pdf`;
    let txns = [];
    try {
      const pr = await fetch(url, { headers: { "User-Agent": UA } });
      if (pr.ok) txns = parsePtrText(await pdfText(new Uint8Array(await pr.arrayBuffer())), { url, docid: f.doc, last: f.last, state: f.state });
    } catch (e) { process.stderr.write(`warn ${f.doc}: ${e.message}\n`); }
    if (txns.length) rows.push(...txns);
    else rows.push({ d: iso(f.date), chamber: "House", who: `Rep. ${f.last}${f.state ? " · " + f.state : ""}`, t: null, act: null, amt: null, url, kind: "ptr-filing" }); // keep filing-level presence
  }
  rows.sort((a, z) => (a.d < z.d ? 1 : -1));
  process.stdout.write(JSON.stringify({ updated: new Date().toISOString(), source: "house-clerk", year: YEAR, rows }, null, 0) + "\n");
  process.stderr.write(`ingested ${filings.length} PTRs -> ${rows.length} rows (${rows.filter((r) => r.t).length} ticker-level)\n`);
}
main().catch((e) => { process.stderr.write("FATAL: " + (e.stack || e) + "\n"); process.exit(1); });
