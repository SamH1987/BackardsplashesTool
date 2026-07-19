// Storage engine. Two modes, same API:
//
//  - Local mode (no DATABASE_URL): every record is a readable JSON file on
//    disk, exactly as before. Zero setup, runs on the founder's Mac.
//  - Cloud mode (DATABASE_URL set): records live in Postgres (Supabase free
//    tier). Everything is loaded into memory at boot, reads stay synchronous,
//    and writes go to the database through a retrying write-behind queue -
//    so the rest of the app code is identical in both modes.
//
// First boot in cloud mode seeds the database from the files shipped in the
// repo (price templates, checklists, catalogue records, the sample job), so
// a fresh deploy works before any migration has run.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = path.join(ROOT, 'config');

const IS_CLOUD = !!process.env.DATABASE_URL;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// Cloud plumbing (only initialised when DATABASE_URL is set)
// ---------------------------------------------------------------------------

let pool = null;
const recordCache = new Map(); // collection -> Map(id -> data)
const configCache = new Map(); // name -> data
const writeQueue = [];
let flushing = false;
let readyPromise = null;

function cacheFor(name) {
  if (!recordCache.has(name)) recordCache.set(name, new Map());
  return recordCache.get(name);
}

function enqueue(op) {
  writeQueue.push(op);
  flushLoop();
}

async function flushLoop() {
  if (flushing || !pool) return;
  flushing = true;
  while (writeQueue.length) {
    const op = writeQueue[0];
    try {
      if (op.type === 'record') {
        await pool.query(
          'INSERT INTO records(collection, id, data) VALUES($1,$2,$3) ' +
          'ON CONFLICT (collection, id) DO UPDATE SET data = $3',
          [op.collection, op.id, JSON.stringify(op.data)]);
      } else if (op.type === 'record_delete') {
        await pool.query('DELETE FROM records WHERE collection=$1 AND id=$2', [op.collection, op.id]);
      } else if (op.type === 'config') {
        await pool.query(
          'INSERT INTO configs(name, data) VALUES($1,$2) ' +
          'ON CONFLICT (name) DO UPDATE SET data = $2',
          [op.name, JSON.stringify(op.data)]);
      } else if (op.type === 'config_delete') {
        await pool.query('DELETE FROM configs WHERE name=$1', [op.name]);
      }
      writeQueue.shift();
    } catch (e) {
      console.error('Database write failed, retrying in 5s:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  flushing = false;
}

function pendingWrites() { return writeQueue.length; }

// Seed collections from repo files so a brand new database isn't empty.
const SEED_DIRS = {
  templates: path.join(DATA, 'templates'),
  catalogue: path.join(DATA, 'catalogue'),
  decking: path.join(DATA, 'decking'),
  customers: path.join(DATA, 'customers'),
  jobs: path.join(DATA, 'jobs'),
  quotes: path.join(DATA, 'quotes'),
  specs: path.join(DATA, 'specs'),
  invoices: path.join(DATA, 'invoices')
};
const SEED_CONFIGS = ['business.json', 'tracker.json', 'update-templates.json',
  'checklists/quote.json', 'checklists/spec.json'];

async function bootCloud() {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 4
  });
  await pool.query(
    'CREATE TABLE IF NOT EXISTS records (collection text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (collection, id))');
  await pool.query(
    'CREATE TABLE IF NOT EXISTS configs (name text PRIMARY KEY, data jsonb NOT NULL)');

  const recs = await pool.query('SELECT collection, id, data FROM records');
  for (const row of recs.rows) cacheFor(row.collection).set(row.id, row.data);
  const confs = await pool.query('SELECT name, data FROM configs');
  for (const row of confs.rows) {
    if (row.data !== null) configCache.set(row.name, row.data);
  }

  // first boot: seed from what's in the repo
  for (const [name, dir] of Object.entries(SEED_DIRS)) {
    if (cacheFor(name).size > 0 || !fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      const data = readJson(path.join(dir, f), null);
      if (data && data.id) {
        cacheFor(name).set(data.id, data);
        enqueue({ type: 'record', collection: name, id: data.id, data });
      }
    }
  }
  for (const name of SEED_CONFIGS) {
    if (configCache.has(name)) continue;
    const data = readJson(path.join(CONFIG, name), null);
    if (data) {
      configCache.set(name, data);
      enqueue({ type: 'config', name, data });
    }
  }
  console.log('  Cloud database connected (' + recs.rows.length + ' records loaded).');
}

function ready() {
  if (!IS_CLOUD) return Promise.resolve();
  if (!readyPromise) readyPromise = bootCloud();
  return readyPromise;
}

// ---------------------------------------------------------------------------
// The collection API - identical shape in both modes
// ---------------------------------------------------------------------------

function collection(name) {
  if (IS_CLOUD) {
    const cache = cacheFor(name);
    return {
      list() {
        return [...cache.values()].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      },
      get(id) {
        return cache.has(id) ? cache.get(id) : null;
      },
      save(record) {
        if (!record.id) throw new Error('record needs an id');
        record.updatedAt = new Date().toISOString();
        cache.set(record.id, record);
        enqueue({ type: 'record', collection: name, id: record.id, data: record });
        return record;
      },
      remove(id) {
        cache.delete(id);
        enqueue({ type: 'record_delete', collection: name, id });
      }
    };
  }

  const dir = path.join(DATA, name);
  ensureDir(dir);
  return {
    dir,
    list() {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => readJson(path.join(dir, f)))
        .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    },
    get(id) {
      const file = path.join(dir, id + '.json');
      if (!fs.existsSync(file)) return null;
      return readJson(file);
    },
    save(record) {
      if (!record.id) throw new Error('record needs an id');
      record.updatedAt = new Date().toISOString();
      writeJson(path.join(dir, record.id + '.json'), record);
      return record;
    },
    remove(id) {
      const file = path.join(dir, id + '.json');
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  };
}

const customers = collection('customers');
const jobs = collection('jobs');
const quotes = collection('quotes');
const specs = collection('specs');
const invoices = collection('invoices');
const templates = collection('templates');

function getConfig(name, fallback) {
  if (IS_CLOUD) {
    if (configCache.has(name)) return configCache.get(name);
    // fall back to the copy shipped in the repo
    return readJson(path.join(CONFIG, name), fallback);
  }
  return readJson(path.join(CONFIG, name), fallback);
}

function saveConfig(name, obj) {
  if (IS_CLOUD) {
    configCache.set(name, obj);
    enqueue({ type: 'config', name, data: obj });
    return;
  }
  writeJson(path.join(CONFIG, name), obj);
}

function deleteConfig(name) {
  if (IS_CLOUD) {
    configCache.delete(name);
    enqueue({ type: 'config_delete', name });
    return;
  }
  const file = path.join(CONFIG, name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = {
  ROOT, DATA, CONFIG, IS_CLOUD,
  newId, readJson, writeJson, ensureDir,
  customers, jobs, quotes, specs, invoices, templates,
  collection, getConfig, saveConfig, deleteConfig,
  ready, pendingWrites,
  uploadsDir: path.join(DATA, 'uploads')
};
