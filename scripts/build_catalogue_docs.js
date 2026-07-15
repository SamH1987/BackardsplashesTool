// Downloads each spa's manufacturer spec/delivery PDF (the one with the
// electrical placement diagram) into data/catalogue-docs/ and records it on
// the catalogue entry as docFile. Spa World and Alpine publish these per
// model; Just Spas does not. Safe to re-run.
// Run with: runtime/bin/node scripts/build_catalogue_docs.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CAT_DIR = path.join(ROOT, 'data', 'catalogue');
const DOC_DIR = path.join(ROOT, 'data', 'catalogue-docs');
fs.mkdirSync(DOC_DIR, { recursive: true });

const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) SpaJobs-docs/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function download(url, file) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 5000 || buf.slice(0, 4).toString() !== '%PDF') throw new Error('not a PDF');
  fs.writeFileSync(path.join(DOC_DIR, file), buf);
  return buf.length;
}

async function run() {
  const records = fs.readdirSync(CAT_DIR).filter(f => f.endsWith('.json'))
    .map(f => ({ file: f, rec: JSON.parse(fs.readFileSync(path.join(CAT_DIR, f))) }));
  let found = 0, missing = 0;

  for (const { file, rec } of records) {
    try {
      let pdfUrl = null;
      if (rec.id.startsWith('sw_') && rec.sourceUrl) {
        const pd = await fetch('https://www.spaworld.com.au/page-data' +
          rec.sourceUrl.replace('https://www.spaworld.com.au', '') + 'page-data.json', UA).then(r => r.json());
        const p = pd.result && pd.result.data && pd.result.data.product;
        pdfUrl = p && p.specDoc && p.specDoc.url;
      } else if (rec.id.startsWith('as_') && rec.sourceUrl) {
        const html = await fetch(rec.sourceUrl, UA).then(r => r.text());
        // the model's own PDF lives under its product folder
        const links = [...new Set(html.match(/https:\/\/cms\.alpinespas\.co\.nz\/assets\/content\/products\/[^"']+\.pdf/g) || [])];
        pdfUrl = links[0] || null;
      }
      if (!pdfUrl) { missing++; continue; }
      const docFile = rec.id + '.pdf';
      const size = await download(pdfUrl, docFile);
      rec.docFile = docFile;
      rec.docSource = pdfUrl;
      fs.writeFileSync(path.join(CAT_DIR, file), JSON.stringify(rec, null, 2));
      found++;
      console.log('  doc for', rec.name, '(' + Math.round(size / 1024) + ' KB)');
      await sleep(250);
    } catch (e) {
      missing++;
      console.log('  no doc for', rec.name, '-', e.message);
    }
  }
  console.log('\nSpec documents: ' + found + ' downloaded, ' + missing + ' models without one.');
}
run();
