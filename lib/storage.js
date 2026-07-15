// Simple JSON-file storage. Every record is one readable file on disk,
// so data stays visible, portable, and easy to sync with other systems later
// (see FUTURE_INTEGRATIONS.md).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = path.join(ROOT, 'config');

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

function collection(name) {
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
const templates = collection('templates');

function getConfig(name, fallback) {
  return readJson(path.join(CONFIG, name), fallback);
}

function saveConfig(name, obj) {
  writeJson(path.join(CONFIG, name), obj);
}

module.exports = {
  ROOT, DATA, CONFIG,
  newId, readJson, writeJson, ensureDir,
  customers, jobs, quotes, specs, templates,
  getConfig, saveConfig,
  uploadsDir: path.join(DATA, 'uploads')
};
