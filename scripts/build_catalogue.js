// Builds the spa catalogue from three retailer websites:
//   Spa World (spaworld.com.au), Just Spas (justspas.com.au), Alpine Spas (alpinespas.com.au)
// Saves one JSON file per model into data/catalogue/ and downloads each
// product photo into data/catalogue-images/. Needs internet. Safe to re-run -
// it refreshes scraped entries but never touches manual ones (id starting "man_").
// Run with: runtime/bin/node scripts/build_catalogue.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CAT_DIR = path.join(ROOT, 'data', 'catalogue');
const IMG_DIR = path.join(ROOT, 'data', 'catalogue-images');
fs.mkdirSync(CAT_DIR, { recursive: true });
fs.mkdirSync(IMG_DIR, { recursive: true });

const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) SpaJobs-catalogue/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getText(url) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.text();
}
async function getJson(url) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.json();
}

function saveModel(rec) {
  rec.createdAt = rec.createdAt || new Date().toISOString();
  rec.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(CAT_DIR, rec.id + '.json'), JSON.stringify(rec, null, 2));
}

async function downloadImage(url, id) {
  try {
    const r = await fetch(url, UA);
    if (!r.ok) throw new Error(String(r.status));
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000) throw new Error('too small');
    const type = (r.headers.get('content-type') || '');
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const file = id + '.' + ext;
    fs.writeFileSync(path.join(IMG_DIR, file), buf);
    return file;
  } catch (e) {
    console.log('   image failed for', id, '-', e.message);
    return null;
  }
}

// Pulls "4.69 x 2.33 x 1.35m" / "2250mm x 2250mm x 940mm" / "2000(L) x 1500(W) x 760(H) mm" into metres.
function parseDims(text) {
  if (!text) return null;
  let m = text.match(/(\d{3,4})\s*(?:\(L\))?\s*(?:mm)?\s*[x×]\s*(\d{3,4})\s*(?:\(W\))?\s*(?:mm)?\s*(?:[x×]\s*(\d{3,4})\s*(?:\(H\))?\s*)?mm/i);
  if (m) return { lengthM: +(m[1] / 1000).toFixed(2), widthM: +(m[2] / 1000).toFixed(2), heightM: m[3] ? +(m[3] / 1000).toFixed(2) : '' };
  m = text.match(/(\d\.\d{1,2})\s*m?\s*[x×]\s*(\d\.\d{1,2})\s*m?\s*(?:[x×]\s*(\d\.\d{1,2})\s*)?m/i);
  if (m) return { lengthM: +m[1], widthM: +m[2], heightM: m[3] ? +m[3] : '' };
  return null;
}

function typeFrom(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('swim')) return 'swim spa';
  if (t.includes('plunge')) return 'plunge pool';
  return 'spa';
}

// ---------------- Just Spas (WooCommerce store API) ----------------
async function justSpas() {
  console.log('Just Spas...');
  const out = [];
  for (let page = 1; page < 8; page++) {
    let list;
    try { list = await getJson('https://justspas.com.au/wp-json/wc/store/products?per_page=100&page=' + page); }
    catch (e) { break; }
    if (!Array.isArray(list) || !list.length) break;
    out.push(...list);
    await sleep(300);
  }
  console.log(' ', out.length, 'products from API');
  for (const p of out) {
    const slug = p.slug.replace(/[^a-z0-9-]/g, '');
    const id = 'js_' + slug;
    const catNames = (p.categories || []).map(c => c.name).join(' ');
    const text = [p.name, p.short_description, p.description].join(' ');
    let dims = parseDims(text);
    // dimensions often only on the product page spec tab - fetch it if missing
    if (!dims) {
      try {
        dims = parseDims(await getText(p.permalink));
        await sleep(250);
      } catch (e) { /* leave blank */ }
    }
    const imgUrl = p.images && p.images[0] && p.images[0].src;
    const image = imgUrl ? await downloadImage(imgUrl, id) : null;
    saveModel({
      id, retailer: 'Just Spas', brand: (p.name.match(/^(LeisureRite|Cyclone|Aqua\w*)/i) || [])[0] || 'Just Spas',
      name: p.name, type: typeFrom(catNames + ' ' + p.name),
      seats: (() => {
        const a = (p.attributes || []).find(x => x.taxonomy === 'pa_seating-capacity');
        if (a && a.terms && a.terms.length) return a.terms.map(t => t.name).join('/');
        return (String(p.name + ' ' + p.slug).match(/(\d+)[\s-]seater/i) || [])[1] || '';
      })(),
      lengthM: dims ? dims.lengthM : '', widthM: dims ? dims.widthM : '', heightM: dims ? dims.heightM : '',
      image, sourceUrl: p.permalink
    });
    console.log('  saved', p.name, dims ? JSON.stringify(dims) : '(no dims)');
    await sleep(150);
  }
}

// ---------------- Spa World (Gatsby page-data) ----------------
async function spaWorld() {
  console.log('Spa World...');
  const xml = await getText('https://www.spaworld.com.au/sitemap/sitemap-0.xml');
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const products = urls.filter(u => /^https:\/\/www\.spaworld\.com\.au\/(spa-pools|swim-spas|plunge-pools)\/[^/]+\/[^/]+\/$/.test(u));
  console.log(' ', products.length, 'product pages');
  for (const u of products) {
    try {
      const pd = await getJson('https://www.spaworld.com.au/page-data' + u.replace('https://www.spaworld.com.au', '') + 'page-data.json');
      const p = pd.result && pd.result.data && pd.result.data.product;
      if (!p || !p.name) continue;
      const slug = u.split('/').filter(Boolean).pop();
      const id = 'sw_' + slug.replace(/[^a-z0-9-]/g, '');
      const neto = p.netoProduct || {};
      let dims = parseDims((p.specDimensions && p.specDimensions.dimensions) || neto.dimensions || '');
      if (!dims && p.specDimensions && p.specDimensions.length && p.specDimensions.width) {
        dims = { lengthM: p.specDimensions.length, widthM: p.specDimensions.width, heightM: '' };
      }
      let imgUrl = null;
      try { imgUrl = p.heroImage.gatsbyImageData.images.fallback.src.split('?')[0] + '?auto=format&w=800'; } catch (e) {}
      const image = imgUrl ? await downloadImage(imgUrl, id) : null;
      saveModel({
        id, retailer: 'Spa World',
        brand: (p.brand && p.brand.name) || '', name: p.name,
        type: typeFrom((p.category && p.category.title) || u),
        seats: neto.seats || '',
        lengthM: dims ? dims.lengthM : '', widthM: dims ? dims.widthM : '', heightM: dims ? dims.heightM : '',
        image, sourceUrl: u
      });
      console.log('  saved', p.name, dims ? JSON.stringify(dims) : '(no dims)');
    } catch (e) { console.log('  skip', u, '-', e.message); }
    await sleep(200);
  }
}

// ---------------- Alpine Spas (page HTML) ----------------
async function alpineSpas() {
  console.log('Alpine Spas...');
  const xml = await getText('https://alpinespas.com.au/sitemap.xml');
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const products = urls.filter(u => /^https:\/\/alpinespas\.com\.au\/(spa-pools|swim-spas)\/[^/]+\/[^/]+$/.test(u));
  console.log(' ', products.length, 'product pages');
  for (const u of products) {
    try {
      const html = await getText(u);
      let title = (html.match(/property="og:title"[^>]*content="([^"]+)"/) || html.match(/content="([^"]+)"[^>]*property="og:title"/) || [])[1] || '';
      if (!title) title = (html.match(/<title>([^<]+)/) || [])[1] || '';
      title = title.split('|')[0].replace(/\s*\|\s*Alpine Spas.*$/i, '').trim();
      if (!title) { console.log('  skip', u, '- no title found'); continue; }
      const slug = u.split('/').filter(Boolean).pop();
      const id = 'as_' + slug.replace(/[^a-z0-9-]/g, '');
      const dims = parseDims(html);
      let imgUrl = (html.match(/property="og:image"[^>]*content="([^"]+)"/) || html.match(/content="([^"]+)"[^>]*property="og:image"/) || [])[1] || null;
      if (imgUrl && imgUrl.includes('cms.alpinespas.co.nz')) {
        imgUrl = imgUrl.replace('https://cms.alpinespas.co.nz', 'https://alpinespas.imgix.net') + '?auto=format,compress&w=800';
      }
      const image = imgUrl ? await downloadImage(imgUrl, id) : null;
      saveModel({
        id, retailer: 'Alpine Spas',
        brand: /bullfrog/i.test(u) ? 'Bullfrog' : 'Alpine Spas', name: title,
        type: typeFrom(u),
        seats: (slug.match(/(\d+)-seater/) || [])[1] || '',
        lengthM: dims ? dims.lengthM : '', widthM: dims ? dims.widthM : '', heightM: dims ? dims.heightM : '',
        image, sourceUrl: u
      });
      console.log('  saved', title, dims ? JSON.stringify(dims) : '(no dims)');
    } catch (e) { console.log('  skip', u, '-', e.message); }
    await sleep(250);
  }
}

(async () => {
  // Optional filter: node scripts/build_catalogue.js alpine   (or: just / spaworld)
  const only = (process.argv[2] || '').toLowerCase();
  if (!only || 'justspas'.includes(only)) await justSpas().catch(e => console.log('Just Spas failed entirely:', e.message));
  if (!only || 'spaworld'.includes(only)) await spaWorld().catch(e => console.log('Spa World failed entirely:', e.message));
  if (!only || 'alpine'.includes(only)) await alpineSpas().catch(e => console.log('Alpine Spas failed entirely:', e.message));
  const files = fs.readdirSync(CAT_DIR).filter(f => f.endsWith('.json'));
  console.log('\nCatalogue now has', files.length, 'models.');
})();
