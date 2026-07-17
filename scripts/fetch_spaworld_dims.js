// Re-checks Spa World models missing dimensions. The original scraper's
// regex required a leading digit before the decimal point (e.g. "0.92m"),
// but some product pages write it as ".92m" with no leading zero, which
// silently failed to match and left the model blank. Fixed pattern here.
// Run: runtime/bin/node scripts/fetch_spaworld_dims.js

const fs = require('fs');
const path = require('path');
const CAT_DIR = path.join(__dirname, '..', 'data', 'catalogue');
const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) SpaJobs-dims/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseDimsFixed(text) {
  if (!text) return null;
  const m = text.match(/(\d*\.\d{1,2})\s*m?\s*[x×]\s*(\d*\.\d{1,2})\s*m?\s*(?:[x×]\s*(\d*\.\d{1,2})\s*)?m/i);
  if (!m) return null;
  return { lengthM: +m[1], widthM: +m[2], heightM: m[3] ? +m[3] : '' };
}

async function main() {
  const files = fs.readdirSync(CAT_DIR).filter(f => f.endsWith('.json'));
  const missing = files.map(f => ({ file: f, rec: JSON.parse(fs.readFileSync(path.join(CAT_DIR, f))) }))
    .filter(x => !x.rec.lengthM && x.rec.retailer === 'Spa World' && x.rec.sourceUrl);

  console.log(missing.length + ' Spa World models to check\n');
  let found = 0, notFound = 0;
  for (const { file, rec } of missing) {
    try {
      const pdUrl = 'https://www.spaworld.com.au/page-data' +
        rec.sourceUrl.replace('https://www.spaworld.com.au', '') + 'page-data.json';
      const pd = await fetch(pdUrl, UA).then(r => r.json());
      const p = pd.result && pd.result.data && pd.result.data.product;
      const raw = p && p.specDimensions && p.specDimensions.dimensions;
      const dims = parseDimsFixed(raw);
      if (!dims || !dims.heightM) {
        notFound++;
        console.log('  no clean dims (raw: ' + JSON.stringify(raw) + '):', rec.name);
        await sleep(200);
        continue;
      }
      rec.lengthM = dims.lengthM; rec.widthM = dims.widthM; rec.heightM = dims.heightM;
      rec.updatedAt = new Date().toISOString();
      fs.writeFileSync(path.join(CAT_DIR, file), JSON.stringify(rec, null, 2));
      found++;
      console.log('  found:', rec.name, '->', dims.lengthM, 'x', dims.widthM, 'x', dims.heightM, '(raw: "' + raw + '")');
    } catch (e) {
      notFound++;
      console.log('  fetch failed:', rec.name, '-', e.message);
    }
    await sleep(250);
  }
  console.log('\n' + found + ' found, ' + notFound + ' still missing.');
}
main();
