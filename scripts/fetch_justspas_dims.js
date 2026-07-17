// Just Spas publishes dimensions in a spec-table widget on the product page
// HTML that their product API doesn't expose (the original scraper only
// checked the API). This fetches each page missing dimensions and pulls the
// "Dimension (mm)" row directly from the page.
// Run: runtime/bin/node scripts/fetch_justspas_dims.js

const fs = require('fs');
const path = require('path');
const CAT_DIR = path.join(__dirname, '..', 'data', 'catalogue');
const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) SpaJobs-dims/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const files = fs.readdirSync(CAT_DIR).filter(f => f.endsWith('.json'));
  const missing = files.map(f => ({ file: f, rec: JSON.parse(fs.readFileSync(path.join(CAT_DIR, f))) }))
    .filter(x => !x.rec.lengthM && x.rec.retailer === 'Just Spas' && x.rec.sourceUrl);

  console.log(missing.length + ' Just Spas models to check\n');
  let found = 0, notFound = 0;
  const results = [];
  for (const { file, rec } of missing) {
    try {
      const html = await fetch(rec.sourceUrl, UA).then(r => r.text());
      const m = html.match(/Dimension[^<]*<\/span>\s*<span[^>]*>([^<]+)<\/span>/i);
      if (!m) { notFound++; console.log('  no dims found:', rec.name); await sleep(200); continue; }
      const dims = m[1].match(/(\d{3,4})\s*[xX×]\s*(\d{3,4})\s*[xX×]\s*(\d{2,4})/);
      if (!dims) { notFound++; console.log('  unparseable dims text "' + m[1] + '":', rec.name); await sleep(200); continue; }
      const [, l, w, d] = dims;
      // the page labels this "Dimension (mm)" - mm to m is divide by 1000
      const lengthM = Math.round(+l) / 1000, widthM = Math.round(+w) / 1000, heightM = Math.round(+d) / 1000;
      rec.lengthM = lengthM; rec.widthM = widthM; rec.heightM = heightM;
      rec.updatedAt = new Date().toISOString();
      fs.writeFileSync(path.join(CAT_DIR, file), JSON.stringify(rec, null, 2));
      results.push({ id: rec.id, name: rec.name, lengthM, widthM, heightM });
      found++;
      console.log('  found:', rec.name, '->', lengthM, 'x', widthM, 'x', heightM);
    } catch (e) {
      notFound++;
      console.log('  fetch failed:', rec.name, '-', e.message);
    }
    await sleep(250);
  }
  console.log('\n' + found + ' found, ' + notFound + ' still missing.');
  fs.writeFileSync('/tmp/justspas_dims_applied.json', JSON.stringify(results, null, 2));
}
main();
