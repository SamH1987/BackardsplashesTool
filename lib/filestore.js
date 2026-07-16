// File storage. Local mode keeps everything on disk exactly as before; cloud
// mode puts uploads and catalogue media in a private Supabase Storage bucket
// (free tier) and streams them back through the server, so nothing is
// publicly reachable without being logged in.

const fs = require('fs');
const path = require('path');
const storage = require('./storage');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'files';

const isCloud = storage.IS_CLOUD && !!SUPABASE_URL && !!SERVICE_KEY;

const LOCAL_DIRS = {
  'uploads': path.join(storage.DATA, 'uploads'),
  'catalogue-images': path.join(storage.DATA, 'catalogue-images'),
  'catalogue-docs': path.join(storage.DATA, 'catalogue-docs'),
  'decking-images': path.join(storage.DATA, 'decking-images')
};

function localPath(area, name) {
  const dir = LOCAL_DIRS[area];
  if (!dir) throw new Error('unknown file area: ' + area);
  const full = path.normalize(path.join(dir, name));
  if (!full.startsWith(dir + path.sep) && full !== dir) throw new Error('bad path');
  return full;
}

function objectPath(area, name) {
  return area + '/' + name.split('/').map(encodeURIComponent).join('/');
}

const HEADERS = { Authorization: 'Bearer ' + SERVICE_KEY };

let bucketReady = null;
function ensureBucket() {
  if (!bucketReady) {
    bucketReady = fetch(SUPABASE_URL + '/storage/v1/bucket', {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: BUCKET, public: false })
    }).catch(() => {}); // already exists / race - uploads will tell us if it's really broken
  }
  return bucketReady;
}

async function save(area, name, buffer, contentType) {
  if (!isCloud) {
    const full = localPath(area, name);
    storage.ensureDir(path.dirname(full));
    fs.writeFileSync(full, buffer);
    return;
  }
  await ensureBucket();
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + objectPath(area, name), {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true' },
    body: buffer
  });
  if (!res.ok) throw new Error('cloud file save failed (' + res.status + '): ' + (await res.text()).slice(0, 200));
}

async function read(area, name) {
  if (!isCloud) {
    try {
      return fs.readFileSync(localPath(area, name));
    } catch (e) { return null; }
  }
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + objectPath(area, name), { headers: HEADERS });
  if (!res.ok) {
    // fall back to a copy shipped on disk (sample images live in the repo)
    try { return fs.readFileSync(localPath(area, name)); } catch (e) { return null; }
  }
  return Buffer.from(await res.arrayBuffer());
}

async function remove(area, name) {
  if (!isCloud) {
    try { fs.unlinkSync(localPath(area, name)); } catch (e) {}
    return;
  }
  await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + objectPath(area, name), {
    method: 'DELETE', headers: HEADERS
  }).catch(() => {});
}

// After multer has written an upload to the local disk, promote it to cloud
// storage (no-op locally, where the disk copy IS the storage).
async function promoteUpload(filename, contentType) {
  if (!isCloud) return;
  const full = localPath('uploads', filename);
  const buf = fs.readFileSync(full);
  await save('uploads', filename, buf, contentType);
  try { fs.unlinkSync(full); } catch (e) {}
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream', '.mp4': 'video/mp4', '.mov': 'video/quicktime'
};
function mimeFor(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

module.exports = { isCloud, save, read, remove, promoteUpload, mimeFor, LOCAL_DIRS };
