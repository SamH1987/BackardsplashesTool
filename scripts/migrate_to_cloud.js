// One-time migration: copies everything on this computer - every record,
// config, photo, document, catalogue image and spec PDF - up to the cloud
// database (Supabase Postgres) and cloud file bucket (Supabase Storage).
// Safe to re-run; it overwrites cloud copies with what's on this machine.
//
// Run from the project folder with the three values from your Supabase project:
//
//   DATABASE_URL='postgresql://...' \
//   SUPABASE_URL='https://xxxx.supabase.co' \
//   SUPABASE_SERVICE_KEY='eyJ...' \
//   runtime/bin/node scripts/migrate_to_cloud.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = path.join(ROOT, 'config');

const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'files';

if (!DATABASE_URL || !SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_KEY - see the comment at the top of this file.');
  process.exit(1);
}

const RECORD_DIRS = ['customers', 'jobs', 'quotes', 'specs', 'templates', 'catalogue', 'decking', 'private'];
const FILE_AREAS = ['uploads', 'catalogue-images', 'catalogue-docs', 'decking-images'];
const CONFIGS = ['business.json', 'tracker.json', 'update-templates.json',
  'checklists/quote.json', 'checklists/spec.json', 'private.json'];

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.aiff': 'audio/aiff'
};

async function main() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });
  await pool.query('CREATE TABLE IF NOT EXISTS records (collection text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (collection, id))');
  await pool.query('CREATE TABLE IF NOT EXISTS configs (name text PRIMARY KEY, data jsonb NOT NULL)');

  // records
  let recCount = 0;
  for (const coll of RECORD_DIRS) {
    const dir = path.join(DATA, coll);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const id = data.id || f.replace(/\.json$/, '');
      data.id = id;
      await pool.query(
        'INSERT INTO records(collection, id, data) VALUES($1,$2,$3) ON CONFLICT (collection, id) DO UPDATE SET data=$3',
        [coll, id, data]);
      recCount++;
    }
    console.log('  ' + coll + ' done');
  }

  // configs
  for (const name of CONFIGS) {
    const file = path.join(CONFIG, name);
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    await pool.query('INSERT INTO configs(name, data) VALUES($1,$2) ON CONFLICT (name) DO UPDATE SET data=$2', [name, data]);
    console.log('  config ' + name + ' done');
  }
  await pool.end();
  console.log('Database: ' + recCount + ' records migrated.');

  // bucket
  await fetch(SUPABASE_URL + '/storage/v1/bucket', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: BUCKET, public: false, file_size_limit: '52428800' })
  }).catch(() => {});

  // files
  let fileCount = 0, skipped = 0;
  for (const area of FILE_AREAS) {
    const dir = path.join(DATA, area);
    if (!fs.existsSync(dir)) continue;
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(en =>
      en.isDirectory() ? walk(path.join(d, en.name)) : [path.join(d, en.name)]);
    for (const full of walk(dir)) {
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (rel.startsWith('.')) continue;
      const buf = fs.readFileSync(full);
      if (buf.length > 50 * 1024 * 1024) {
        console.log('  skipped (over 50MB): ' + area + '/' + rel);
        skipped++;
        continue;
      }
      const objectPath = area + '/' + rel.split('/').map(encodeURIComponent).join('/');
      const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + objectPath, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + SERVICE_KEY,
          'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
          'x-upsert': 'true'
        },
        body: buf
      });
      if (!res.ok) {
        console.log('  FAILED: ' + area + '/' + rel + ' (' + res.status + ') ' + (await res.text()).slice(0, 120));
        skipped++;
      } else {
        fileCount++;
        if (fileCount % 50 === 0) console.log('  ...' + fileCount + ' files up');
      }
    }
    console.log('  ' + area + ' done');
  }
  console.log('Files: ' + fileCount + ' uploaded' + (skipped ? ', ' + skipped + ' skipped' : '') + '.');
  console.log('\nMigration complete. The cloud version now mirrors this computer.');
}

main().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
