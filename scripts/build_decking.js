// Builds the decking board library from timberprices.com.au:
//   Innowood (InnoDeck, Plus Dek embossed grain, Plus Dek weathered) and Millboard.
// One JSON per board in data/decking/, board photos in data/decking-images/.
// Safe to re-run. Run with: runtime/bin/node scripts/build_decking.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DECK_DIR = path.join(ROOT, 'data', 'decking');
const IMG_DIR = path.join(ROOT, 'data', 'decking-images');
fs.mkdirSync(DECK_DIR, { recursive: true });
fs.mkdirSync(IMG_DIR, { recursive: true });

const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) SpaJobs-decking/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SOURCES = [
  { brand: 'Innowood', categoryId: 2206 },
  { brand: 'Millboard', categoryId: 730 }
];
// nicer range names for the sub-categories the products sit in
const RANGE_NAMES = {
  'innodeck': 'InnoDeck', 'innowood-plus-dek-embossed-grain': 'Plus Dek embossed grain',
  'plus-dek-weathered': 'Plus Dek weathered', 'enhanced-grain': 'Enhanced grain',
  'weathered-oak': 'Weathered oak', 'millboard': '', 'innowood': ''
};

async function run() {
  for (const src of SOURCES) {
    console.log(src.brand + '...');
    let products = [];
    for (let page = 1; page < 5; page++) {
      const r = await fetch('https://timberprices.com.au/wp-json/wc/store/products?per_page=100&page=' + page + '&category=' + src.categoryId, UA);
      if (!r.ok) break;
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) break;
      products.push(...list);
      await sleep(300);
    }
    console.log(' ', products.length, 'boards');
    for (const p of products) {
      // boards only - not clips, trims, tools, paint or cladding
      if (/clip|drill|tool|screw|paint|primer|sample|trim|corner|tuffblock|cladding|tape|seal|fixing|pack|adhesive|glue/i.test(p.name)) continue;
      const id = (src.brand === 'Innowood' ? 'iw_' : 'mb_') + p.slug.replace(/[^a-z0-9-]/g, '');
      const range = (p.categories || []).map(c => RANGE_NAMES[c.slug]).filter(Boolean)[0] || '';
      let image = null;
      const imgUrl = p.images && p.images[0] && p.images[0].src;
      if (imgUrl) {
        try {
          const ir = await fetch(imgUrl, UA);
          if (ir.ok) {
            const buf = Buffer.from(await ir.arrayBuffer());
            const ext = (ir.headers.get('content-type') || '').includes('png') ? 'png' : 'jpg';
            image = id + '.' + ext;
            fs.writeFileSync(path.join(IMG_DIR, image), buf);
          }
        } catch (e) { console.log('   image failed for', id); }
      }
      const rec = {
        id, brand: src.brand, range,
        name: p.name,
        image, sourceUrl: p.permalink,
        createdAt: new Date().toISOString()
      };
      fs.writeFileSync(path.join(DECK_DIR, id + '.json'), JSON.stringify(rec, null, 2));
      console.log('  saved', p.name, range ? '(' + range + ')' : '');
      await sleep(200);
    }
  }
  console.log('\nDecking library:', fs.readdirSync(DECK_DIR).filter(f => f.endsWith('.json')).length, 'boards.');
}
run();
