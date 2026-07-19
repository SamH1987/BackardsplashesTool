// Spa Jobs - site survey, quoting and job management.
// Start with: npm start   (then open http://localhost:4321)

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const storage = require('./lib/storage');
const filestore = require('./lib/filestore');
const { prefillLineItems, buildScopeDescription, quoteTotals } = require('./lib/prefill');
const { buildSpec, tradeLabel } = require('./lib/specgen');
const { runChecks } = require('./lib/checks');
const pdf = require('./lib/pdf');
const { structureNotes } = require('./lib/transcribe');

const app = express();
const PORT = process.env.PORT || 4321;

// ---- Login gate (cloud) -------------------------------------------------------
// When APP_PASSWORD is set (it always is on the hosted version), every data
// route needs the session cookie. The static shell stays public so the login
// page and the offline app can load; all actual business data sits behind this.
const nodeCrypto = require('crypto');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
function sessionToken() {
  return nodeCrypto.createHmac('sha256', APP_PASSWORD).update('spa-jobs-session-v1').digest('hex');
}
function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  return (req.headers.cookie || '').split(/;\s*/).includes('sjauth=' + sessionToken());
}

app.use(express.json({ limit: '25mb' }));

app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const given = String((req.body || {}).password || '');
  if (given !== APP_PASSWORD) {
    return setTimeout(() => res.status(401).json({ error: 'Wrong password' }), 800);
  }
  res.setHeader('Set-Cookie', 'sjauth=' + sessionToken() +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000' + (process.env.CLOUD ? '; Secure' : ''));
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  const protectedPath = req.path.startsWith('/api/') || req.path.startsWith('/uploads') ||
    req.path.startsWith('/catalogue-') || req.path.startsWith('/decking-images');
  const open = req.path === '/api/login' || req.path === '/api/meta';
  if (protectedPath && !open && !isAuthed(req)) {
    return res.status(401).json({ error: 'login required' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// File serving: straight off the disk locally; streamed out of the private
// cloud bucket (behind the login) when hosted.
if (filestore.isCloud) {
  // Supports HTTP Range requests (206 partial content) so video/audio
  // players can scrub and seek instead of needing the whole file up front.
  const serveArea = area => async (req, res) => {
    try {
      const name = decodeURIComponent(req.params[0] || '');
      const buf = await filestore.read(area, name);
      if (!buf) return res.status(404).end();
      res.setHeader('Content-Type', filestore.mimeFor(name));
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('Accept-Ranges', 'bytes');
      const range = req.headers.range;
      const m = range && range.match(/^bytes=(\d*)-(\d*)$/);
      if (m) {
        const total = buf.length;
        let start = m[1] === '' ? 0 : parseInt(m[1], 10);
        let end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
        if (isNaN(start) || isNaN(end) || start > end || start >= total) {
          res.setHeader('Content-Range', 'bytes */' + total);
          return res.status(416).end();
        }
        end = Math.min(end, total - 1);
        res.status(206);
        res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + total);
        res.setHeader('Content-Length', end - start + 1);
        return res.end(buf.slice(start, end + 1));
      }
      res.send(buf);
    } catch (e) { res.status(400).end(); }
  };
  app.get('/uploads/*', serveArea('uploads'));
  app.get('/catalogue-images/*', serveArea('catalogue-images'));
  app.get('/catalogue-docs/*', serveArea('catalogue-docs'));
  app.get('/decking-images/*', serveArea('decking-images'));
} else {
  app.use('/uploads', express.static(storage.uploadsDir));
}

storage.ensureDir(storage.uploadsDir);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, storage.uploadsDir),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, Date.now() + '_' + safe);
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
});

function err(res, status, message) {
  res.status(status).json({ error: message });
}

// ---- Customers --------------------------------------------------------------

app.get('/api/customers', (req, res) => res.json(storage.customers.list()));

app.post('/api/customers', (req, res) => {
  const c = req.body || {};
  if (!(c.name || '').trim()) return err(res, 400, 'Customer needs a name');
  const record = {
    id: storage.newId('cust'),
    name: c.name.trim(),
    phone: c.phone || '', email: c.email || '', address: c.address || '',
    notes: c.notes || '',
    // Hooks for future syncing - see FUTURE_INTEGRATIONS.md
    externalRefs: { xero: null, googleDrive: null, uconnect: null },
    createdAt: new Date().toISOString()
  };
  storage.customers.save(record);
  res.json(record);
});

app.put('/api/customers/:id', (req, res) => {
  const existing = storage.customers.get(req.params.id);
  if (!existing) return err(res, 404, 'Customer not found');
  const allowed = ['name', 'phone', 'email', 'address', 'notes'];
  for (const k of allowed) if (req.body[k] !== undefined) existing[k] = req.body[k];
  storage.customers.save(existing);
  res.json(existing);
});

// ---- Jobs -------------------------------------------------------------------

const STAGES = ['lead', 'survey_done', 'quote_sent', 'accepted', 'contractors_booked', 'in_progress', 'complete', 'invoiced'];

app.get('/api/jobs', (req, res) => {
  let list = storage.jobs.list();
  if (req.query.customerId) list = list.filter(j => j.customerId === req.query.customerId);
  res.json(list);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  res.json(job);
});

app.post('/api/jobs', (req, res) => {
  const b = req.body || {};
  if (!b.customerId || !storage.customers.get(b.customerId)) return err(res, 400, 'Job needs a valid customer');
  const now = new Date().toISOString();
  const job = {
    id: storage.newId('job'),
    customerId: b.customerId,
    title: b.title || 'New job',
    siteAddress: b.siteAddress || (storage.customers.get(b.customerId).address || ''),
    installType: b.installType || '',
    approvalStatus: b.approvalStatus || 'not_checked',
    stage: 'lead',
    stageHistory: [{ stage: 'lead', date: now }],
    responsible: b.responsible || 'Founder',
    nextAction: { text: b.nextActionText || 'Book the site survey', due: b.nextActionDue || '', who: b.responsible || 'Founder' },
    survey: null,
    documents: [],
    updatesLog: [],
    createdAt: now
  };
  storage.jobs.save(job);
  res.json(job);
});

app.put('/api/jobs/:id', (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  const b = req.body || {};
  const allowed = ['title', 'siteAddress', 'installType', 'approvalStatus', 'responsible', 'survey', 'documents'];
  for (const k of allowed) if (b[k] !== undefined) job[k] = b[k];
  if (b.nextAction !== undefined) {
    if (!(b.nextAction.text || '').trim()) return err(res, 400, 'Next action can never be empty. Write what happens next, even if it is "close the file".');
    job.nextAction = b.nextAction;
  }
  if (b.stage !== undefined && b.stage !== job.stage) {
    if (!STAGES.includes(b.stage)) return err(res, 400, 'Unknown stage');
    job.stage = b.stage;
    job.stageHistory.push({ stage: b.stage, date: new Date().toISOString() });
  }
  storage.jobs.save(job);
  res.json(job);
});

// ---- Job documents: plans, engineering, anything worth keeping on the job ----

app.post('/api/jobs/:id/documents', upload.single('file'), async (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  if (!req.file) return err(res, 400, 'No file received');
  await filestore.promoteUpload(req.file.filename, filestore.mimeFor(req.file.filename));
  job.documents = job.documents || [];
  job.documents.push({
    label: (req.body.label || req.file.originalname).trim(),
    file: req.file.filename,
    addedAt: new Date().toISOString()
  });
  storage.jobs.save(job);
  res.json(job.documents);
});

app.delete('/api/jobs/:id/documents/:file', async (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  const safe = req.params.file.replace(/[^a-zA-Z0-9._-]/g, '');
  job.documents = (job.documents || []).filter(d => d.file !== safe);
  await filestore.remove('uploads', safe);
  storage.jobs.save(job);
  res.json(job.documents);
});

// ---- Survey uploads ---------------------------------------------------------

app.post('/api/jobs/:id/photos', upload.single('photo'), async (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  if (!req.file) return err(res, 400, 'No photo received');
  await filestore.promoteUpload(req.file.filename, filestore.mimeFor(req.file.filename));
  job.survey = job.survey || emptySurvey();
  const photo = { id: storage.newId('photo'), file: req.file.filename, annotatedFile: null, caption: req.body.caption || '' };
  job.survey.photos.push(photo);
  storage.jobs.save(job);
  res.json(photo);
});

// Annotated version arrives as a data-URL PNG from the drawing canvas.
app.post('/api/jobs/:id/photos/:photoId/annotate', async (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job || !job.survey) return err(res, 404, 'Job or survey not found');
  const photo = job.survey.photos.find(p => p.id === req.params.photoId);
  if (!photo) return err(res, 404, 'Photo not found');
  const dataUrl = (req.body || {}).dataUrl || '';
  const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!m) return err(res, 400, 'Expected a PNG data URL');
  const filename = 'annotated_' + photo.id + '.png';
  await filestore.save('uploads', filename, Buffer.from(m[1], 'base64'), 'image/png');
  photo.annotatedFile = filename;
  storage.jobs.save(job);
  res.json(photo);
});

app.post('/api/jobs/:id/sketch', async (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  job.survey = job.survey || emptySurvey();
  const m = ((req.body || {}).dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
  if (!m) return err(res, 400, 'Expected a PNG data URL');
  const filename = 'sketch_' + job.id + '_' + Date.now() + '.png';
  await filestore.save('uploads', filename, Buffer.from(m[1], 'base64'), 'image/png');
  job.survey.sketch = { file: filename };
  storage.jobs.save(job);
  res.json(job.survey.sketch);
});

// 3D scan of the yard - shown in the 3D viewer. Takes a .glb / .gltf straight,
// or the .zip Polycam exports (model plus its texture files) and unpacks it.
app.post('/api/jobs/:id/scan', upload.single('scan'), async (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  if (!req.file) return err(res, 400, 'No scan file received');
  let scanFile = req.file.filename;
  if (/\.zip$/i.test(scanFile)) {
    try {
      const unzipper = require('unzipper');
      const dir = 'scan_' + job.id + '_' + Date.now();
      const dirPath = path.join(storage.uploadsDir, dir);
      const zipPath = path.join(storage.uploadsDir, scanFile);
      const directory = await unzipper.Open.file(zipPath);
      await directory.extract({ path: dirPath });
      fs.unlinkSync(zipPath);
      // find the model inside - .glb first, else .gltf (textures sit alongside)
      const found = findModelFile(dirPath, dirPath);
      if (!found) return err(res, 400, 'No 3D model found inside that zip. In Polycam, export as GLTF (not raw data).');
      scanFile = dir + '/' + found;
      if (filestore.isCloud) {
        // push every extracted file (model + its textures) to cloud storage
        const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(en =>
          en.isDirectory() ? walk(path.join(d, en.name)) : [path.join(d, en.name)]);
        for (const f of walk(dirPath)) {
          const rel = dir + '/' + path.relative(dirPath, f).split(path.sep).join('/');
          await filestore.save('uploads', rel, fs.readFileSync(f), filestore.mimeFor(f));
        }
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch (e) {
      return err(res, 500, 'Could not unpack the zip: ' + e.message);
    }
  } else if (!/\.(glb|gltf)$/i.test(scanFile)) {
    return err(res, 400, 'Upload the scan as GLTF/GLB, or the zip that Polycam exports.');
  } else {
    await filestore.promoteUpload(scanFile, filestore.mimeFor(scanFile));
  }
  job.survey = job.survey || emptySurvey();
  job.survey.scan = { file: scanFile };
  storage.jobs.save(job);
  res.json(job.survey.scan);
});

function findModelFile(dir, root) {
  let gltf = null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findModelFile(full, root);
      if (nested && /\.glb$/i.test(nested)) return nested;
      if (nested && !gltf) gltf = nested;
    } else if (/\.glb$/i.test(entry.name)) {
      return path.relative(root, full);
    } else if (/\.gltf$/i.test(entry.name) && !gltf) {
      gltf = path.relative(root, full);
    }
  }
  return gltf;
}

app.post('/api/jobs/:id/video', upload.single('video'), async (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  if (!req.file) return err(res, 400, 'No video received');
  await filestore.promoteUpload(req.file.filename, filestore.mimeFor(req.file.filename));
  job.survey = job.survey || emptySurvey();
  job.survey.video.file = req.file.filename;
  storage.jobs.save(job);
  res.json(job.survey.video);
});

app.post('/api/jobs/:id/transcribe', async (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job || !job.survey || !job.survey.video.file) return err(res, 400, 'Upload a video first');
  if (process.env.DISABLE_TRANSCRIBE) {
    return err(res, 503, 'Transcription is not available on the hosted version (it needs more memory than the free server has). Type or paste the walkthrough notes instead, then use Sort transcript into notes.');
  }
  let stagedPath = null;
  try {
    const { transcribe } = require('./lib/transcribe');
    // ffmpeg needs a real file on disk to read - in cloud mode the upload
    // was already moved into Supabase storage, so pull it back down first.
    const videoName = job.survey.video.file;
    if (filestore.isCloud) {
      const buf = await filestore.read('uploads', videoName);
      if (!buf) return err(res, 404, 'The video could not be found in storage. Try uploading it again.');
      stagedPath = path.join(storage.uploadsDir, 'transcribe_tmp_' + Date.now() + '_' + path.basename(videoName));
      storage.ensureDir(path.dirname(stagedPath));
      fs.writeFileSync(stagedPath, buf);
    } else {
      stagedPath = path.join(storage.uploadsDir, videoName);
    }
    const text = await transcribe(stagedPath);
    job.survey.video.transcript = text;
    job.survey.video.structuredNotes = structureNotes(text);
    storage.jobs.save(job);
    res.json(job.survey.video);
  } catch (e) {
    err(res, 500, 'Transcription did not work (' + e.message + '). You can type or paste the notes instead - the Structure Notes button still works on typed text.');
  } finally {
    if (stagedPath && filestore.isCloud) {
      try { fs.unlinkSync(stagedPath); } catch (e) { /* temp file, fine either way */ }
    }
  }
});

// Structure typed/pasted notes without a video.
app.post('/api/structure-notes', (req, res) => {
  res.json(structureNotes((req.body || {}).text || ''));
});

function emptySurvey() {
  return {
    completedBy: '', date: new Date().toISOString().slice(0, 10),
    photos: [],
    video: { file: null, transcript: '', structuredNotes: { position: [], dimensions: [], access: [], hazards: [], requests: [], general: [] } },
    sketch: { file: null },
    scan: { file: null }, // 3D scan of the yard (GLB), optional
    spaModel: null, // set when a spa is picked from the catalogue
    measurements: {
      spa: { lengthM: '', widthM: '', depthM: '', weightKg: '' },
      excavation: { lengthM: '', widthM: '', depthM: '' },
      slab: { lengthM: '', widthM: '', depthM: '' },
      retainingWalls: [],
      decking: { lengthM: '', widthM: '', placement: 'front', brand: '' },
      plumbing: { drainagePitRequired: false, notes: '' },
      electrical: { supplyAmps: '', runM: '' },
      distances: [], accessWidthM: '', stepLevelChanges: ''
    },
    conditions: { groundType: '', slope: '', obstacles: '', visibleUtilities: '', craneNeeded: false, machineryNotes: '' },
    wishlist: '', budgetIndication: ''
  };
}
app.get('/api/empty-survey', (req, res) => res.json(emptySurvey()));

// ---- Templates ---------------------------------------------------------------

app.get('/api/templates', (req, res) => res.json(storage.templates.list()));

app.post('/api/templates', (req, res) => {
  const t = req.body || {};
  const record = {
    id: storage.newId('tmpl'),
    name: t.name || 'New template',
    installType: t.installType || '',
    description: t.description || '',
    lineItems: t.lineItems || [],
    createdAt: new Date().toISOString()
  };
  storage.templates.save(record);
  res.json(record);
});

app.put('/api/templates/:id', (req, res) => {
  const t = storage.templates.get(req.params.id);
  if (!t) return err(res, 404, 'Template not found');
  for (const k of ['name', 'installType', 'description', 'lineItems']) {
    if (req.body[k] !== undefined) t[k] = req.body[k];
  }
  storage.templates.save(t);
  res.json(t);
});

app.delete('/api/templates/:id', (req, res) => {
  storage.templates.remove(req.params.id);
  res.json({ ok: true });
});

// ---- Quotes -----------------------------------------------------------------

app.get('/api/quotes', (req, res) => {
  let list = storage.quotes.list();
  if (req.query.jobId) list = list.filter(q => q.jobId === req.query.jobId);
  res.json(list.map(q => ({ ...q, totals: quoteTotals(q) })));
});

app.get('/api/quotes/:id', (req, res) => {
  const q = storage.quotes.get(req.params.id);
  if (!q) return err(res, 404, 'Quote not found');
  res.json({ ...q, totals: quoteTotals(q) });
});

app.post('/api/quotes', (req, res) => {
  const { jobId, templateId } = req.body || {};
  const job = storage.jobs.get(jobId);
  const template = storage.templates.get(templateId);
  if (!job) return err(res, 400, 'Job not found');
  if (!template) return err(res, 400, 'Template not found');
  const biz = storage.getConfig('business.json', {});
  // Sequential quote number matching the founder's existing QU-0000 series -
  // assigned once, at creation, and the counter never reused even if the
  // quote is later deleted.
  const nextNum = biz.nextQuoteNumber || 1;
  const quoteNumber = (biz.quoteNumberPrefix || 'QU-') + String(nextNum).padStart(4, '0');
  storage.saveConfig('business.json', { ...biz, nextQuoteNumber: nextNum + 1 });
  const quote = {
    id: storage.newId('quote'),
    quoteNumber,
    jobId, templateId, templateName: template.name,
    status: 'draft',
    dates: { created: new Date().toISOString(), sent: null, accepted: null, declined: null },
    scopeDescription: buildScopeDescription(job, job.survey, template),
    lineItems: prefillLineItems(template, job.survey || emptySurvey()),
    marginPercent: biz.defaultMarginPercent != null ? biz.defaultMarginPercent : 15,
    displayMode: 'itemised',
    validityDays: biz.validityDaysDefault || 30,
    paymentTerms: biz.paymentTermsDefault || '',
    manualChecks: {},
    checkResults: null,
    createdAt: new Date().toISOString()
  };
  storage.quotes.save(quote);
  res.json({ ...quote, totals: quoteTotals(quote) });
});

app.put('/api/quotes/:id', (req, res) => {
  const q = storage.quotes.get(req.params.id);
  if (!q) return err(res, 404, 'Quote not found');
  const allowed = ['scopeDescription', 'lineItems', 'marginPercent', 'displayMode', 'validityDays', 'paymentTerms', 'manualChecks'];
  for (const k of allowed) if (req.body[k] !== undefined) q[k] = req.body[k];
  q.checkResults = null; // edits invalidate the last check run
  storage.quotes.save(q);
  res.json({ ...q, totals: quoteTotals(q) });
});

app.post('/api/quotes/:id/check', (req, res) => {
  const q = storage.quotes.get(req.params.id);
  if (!q) return err(res, 404, 'Quote not found');
  const job = storage.jobs.get(q.jobId);
  q.checkResults = runChecks('quote', q, { job, survey: job && job.survey });
  storage.quotes.save(q);
  res.json(q.checkResults);
});

app.post('/api/quotes/:id/status', (req, res) => {
  const q = storage.quotes.get(req.params.id);
  if (!q) return err(res, 404, 'Quote not found');
  const status = (req.body || {}).status;
  if (!['draft', 'sent', 'accepted', 'declined'].includes(status)) return err(res, 400, 'Unknown status');
  // The self-check gate: a quote cannot go out until the check pass is clean.
  if (status === 'sent') {
    const job = storage.jobs.get(q.jobId);
    q.checkResults = runChecks('quote', q, { job, survey: job && job.survey });
    if (!q.checkResults.allPassed) {
      storage.quotes.save(q);
      return res.status(409).json({ error: 'Self-check failed - fix the flagged items first', checkResults: q.checkResults });
    }
  }
  q.status = status;
  q.dates[status === 'draft' ? 'created' : status] = new Date().toISOString();
  storage.quotes.save(q);
  // Keep the job stage in step.
  const job = storage.jobs.get(q.jobId);
  if (job) {
    if (status === 'sent' && ['lead', 'survey_done'].includes(job.stage)) {
      job.stage = 'quote_sent';
      job.stageHistory.push({ stage: 'quote_sent', date: new Date().toISOString() });
      job.nextAction = { text: 'Follow up quote with ' + (storage.customers.get(job.customerId) || {}).name, due: '', who: job.responsible };
      storage.jobs.save(job);
    }
    if (status === 'accepted' && ['lead', 'survey_done', 'quote_sent'].includes(job.stage)) {
      job.stage = 'accepted';
      job.stageHistory.push({ stage: 'accepted', date: new Date().toISOString() });
      job.nextAction = { text: 'Generate contractor specs and book trades', due: '', who: job.responsible };
      storage.jobs.save(job);
    }
  }
  res.json({ ...q, totals: quoteTotals(q) });
});

app.get('/api/quotes/:id/pdf', (req, res) => {
  const q = storage.quotes.get(req.params.id);
  if (!q) return err(res, 404, 'Quote not found');
  const job = storage.jobs.get(q.jobId);
  const customer = job && storage.customers.get(job.customerId);
  pdf.quotePdf(res, q, job || {}, customer);
});

// ---- Invoices -----------------------------------------------------------------
// Matches the founder's real payment terms: 10% deposit / 80% on commencement /
// 10% on completion. Three staged invoices are generated together from an
// accepted quote's total (incl GST) and tracked/sent/paid independently.

const INVOICE_STAGES = [
  { stage: 'deposit', label: 'Deposit', percent: 10 },
  { stage: 'progress', label: 'Progress Payment', percent: 80 },
  { stage: 'final', label: 'Final Payment', percent: 10 }
];

app.get('/api/invoices', (req, res) => {
  let list = storage.invoices.list();
  if (req.query.jobId) list = list.filter(i => i.jobId === req.query.jobId);
  if (req.query.quoteId) list = list.filter(i => i.quoteId === req.query.quoteId);
  res.json(list);
});

app.get('/api/invoices/:id', (req, res) => {
  const inv = storage.invoices.get(req.params.id);
  if (!inv) return err(res, 404, 'Invoice not found');
  res.json(inv);
});

app.post('/api/quotes/:id/invoices', (req, res) => {
  const q = storage.quotes.get(req.params.id);
  if (!q) return err(res, 404, 'Quote not found');
  const existing = storage.invoices.list().filter(i => i.quoteId === q.id);
  if (existing.length) return res.json(existing);
  const job = storage.jobs.get(q.jobId);
  const quoteTotal = quoteTotals(q).total;
  const biz = storage.getConfig('business.json', {});
  let nextNum = biz.nextInvoiceNumber || 1;
  const created = [];
  for (const s of INVOICE_STAGES) {
    const total = Math.round(quoteTotal * (s.percent / 100) * 100) / 100;
    const subtotal = Math.round((total / 1.1) * 100) / 100;
    const gst = Math.round((total - subtotal) * 100) / 100;
    const invoiceNumber = (biz.invoiceNumberPrefix || 'INV-') + String(nextNum).padStart(4, '0');
    nextNum++;
    const inv = {
      id: storage.newId('invoice'),
      invoiceNumber,
      quoteId: q.id,
      jobId: q.jobId,
      stage: s.stage,
      stageLabel: s.label,
      percent: s.percent,
      subtotal, gst, total,
      quoteNumber: q.quoteNumber,
      quoteTotal,
      status: 'draft',
      dueDate: '',
      notes: '',
      dates: { created: new Date().toISOString(), sent: null, paid: null },
      createdAt: new Date().toISOString()
    };
    storage.invoices.save(inv);
    created.push(inv);
  }
  storage.saveConfig('business.json', { ...biz, nextInvoiceNumber: nextNum });
  res.json(created);
});

app.put('/api/invoices/:id', (req, res) => {
  const inv = storage.invoices.get(req.params.id);
  if (!inv) return err(res, 404, 'Invoice not found');
  const allowed = ['dueDate', 'notes'];
  for (const k of allowed) if (req.body[k] !== undefined) inv[k] = req.body[k];
  storage.invoices.save(inv);
  res.json(inv);
});

app.post('/api/invoices/:id/status', (req, res) => {
  const inv = storage.invoices.get(req.params.id);
  if (!inv) return err(res, 404, 'Invoice not found');
  const status = (req.body || {}).status;
  if (!['draft', 'sent', 'paid'].includes(status)) return err(res, 400, 'Unknown status');
  inv.status = status;
  inv.dates[status === 'draft' ? 'created' : status] = new Date().toISOString();
  storage.invoices.save(inv);
  res.json(inv);
});

app.get('/api/invoices/:id/pdf', (req, res) => {
  const inv = storage.invoices.get(req.params.id);
  if (!inv) return err(res, 404, 'Invoice not found');
  const job = storage.jobs.get(inv.jobId);
  const customer = job && storage.customers.get(job.customerId);
  pdf.invoicePdf(res, inv, job || {}, customer);
});

// ---- Contractor specs ----------------------------------------------------------

app.get('/api/specs', (req, res) => {
  let list = storage.specs.list();
  if (req.query.jobId) list = list.filter(s => s.jobId === req.query.jobId);
  res.json(list);
});

app.get('/api/specs/:id', (req, res) => {
  const s = storage.specs.get(req.params.id);
  if (!s) return err(res, 404, 'Spec not found');
  res.json(s);
});

// Generate one spec per trade found in the accepted quote.
app.post('/api/jobs/:id/specs/generate', (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  // Prefer the accepted quote, but a draft/sent quote works too - the founder
  // often needs a contractor's price to confirm his own quote first.
  const quotes = storage.quotes.list().filter(q => q.jobId === job.id);
  if (!quotes.length) return err(res, 400, 'No quote on this job yet. Specs are generated from a quote so the contractor sees exactly what is being priced.');
  const quote = quotes.find(q => q.status === 'accepted') || quotes[quotes.length - 1];
  const trades = [...new Set((quote.lineItems || [])
    .filter(li => li.included !== false)
    .map(li => li.trade || 'general'))];
  const created = [];
  for (const trade of trades) {
    const already = storage.specs.list().find(s => s.jobId === job.id && s.trade === trade && s.quoteId === quote.id);
    if (already) { created.push(already); continue; }
    const spec = buildSpec(trade, job, job.survey, quote, storage.newId);
    storage.specs.save(spec);
    created.push(spec);
  }
  res.json(created);
});

app.put('/api/specs/:id', (req, res) => {
  const s = storage.specs.get(req.params.id);
  if (!s) return err(res, 404, 'Spec not found');
  const allowed = ['scope', 'position', 'dimensions', 'accessNotes', 'hazards', 'materials', 'questions', 'photoIds', 'includeSketch', 'manualChecks', 'attachDocs', 'includeSpaDoc'];
  for (const k of allowed) if (req.body[k] !== undefined) s[k] = req.body[k];
  s.checkResults = null;
  storage.specs.save(s);
  res.json(s);
});

app.post('/api/specs/:id/check', (req, res) => {
  const s = storage.specs.get(req.params.id);
  if (!s) return err(res, 404, 'Spec not found');
  s.checkResults = runChecks('spec', s, {});
  storage.specs.save(s);
  res.json(s.checkResults);
});

app.post('/api/specs/:id/finalise', (req, res) => {
  const s = storage.specs.get(req.params.id);
  if (!s) return err(res, 404, 'Spec not found');
  s.checkResults = runChecks('spec', s, {});
  if (!s.checkResults.allPassed) {
    storage.specs.save(s);
    return res.status(409).json({ error: 'Self-check failed - fix the flagged items first', checkResults: s.checkResults });
  }
  s.status = 'final';
  storage.specs.save(s);
  res.json(s);
});

app.get('/api/specs/:id/pdf', async (req, res) => {
  const s = storage.specs.get(req.params.id);
  if (!s) return err(res, 404, 'Spec not found');
  const job = storage.jobs.get(s.jobId);
  const customer = job && storage.customers.get(job.customerId);
  let buffer = await pdf.specPdfBuffer(s, job || {}, customer, job && job.survey);

  // Staple attachments on the end: the manufacturer's spec/delivery doc
  // (electrical placement) and any job plans ticked on the spec.
  const attachments = [];
  const sm = job && job.survey && job.survey.spaModel;
  const wantSpaDoc = s.includeSpaDoc !== undefined
    ? s.includeSpaDoc
    : (s.trade === 'electrical' || s.trade === 'crane');
  if (wantSpaDoc && sm) {
    const cat = catalogueRecord(sm.id);
    if (cat && cat.docFile) {
      const bytes = await filestore.read('catalogue-docs', cat.docFile);
      if (bytes) attachments.push({ bytes, type: 'pdf' });
    }
  }
  for (const f of s.attachDocs || []) {
    const d = ((job && job.documents) || []).find(x => x.file === f);
    if (!d) continue;
    const ext = path.extname(d.file).toLowerCase();
    const type = ext === '.pdf' ? 'pdf' : ext === '.png' ? 'png' : (ext === '.jpg' || ext === '.jpeg') ? 'jpg' : null;
    if (!type) continue;
    const bytes = await filestore.read('uploads', d.file);
    if (bytes) attachments.push({ bytes, type });
  }
  if (attachments.length) {
    try {
      const { PDFDocument } = require('pdf-lib');
      const merged = await PDFDocument.load(buffer);
      for (const a of attachments) {
        const bytes = a.bytes;
        if (a.type === 'pdf') {
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await merged.copyPages(src, src.getPageIndices());
          pages.forEach(p => merged.addPage(p));
        } else {
          const img = a.type === 'png' ? await merged.embedPng(bytes) : await merged.embedJpg(bytes);
          const page = merged.addPage([595.28, 841.89]);
          const scale = Math.min(495 / img.width, 700 / img.height);
          page.drawImage(img, {
            x: (595.28 - img.width * scale) / 2, y: (841.89 - img.height * scale) / 2,
            width: img.width * scale, height: img.height * scale
          });
        }
      }
      buffer = Buffer.from(await merged.save());
    } catch (e) {
      console.log('Could not attach documents to spec PDF:', e.message);
    }
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="spec-' + s.trade + '-' + s.id + '.pdf"');
  res.send(buffer);
});

app.delete('/api/specs/:id', (req, res) => {
  storage.specs.remove(req.params.id);
  res.json({ ok: true });
});

// ---- Tracker: this week + stale flags ----------------------------------------

app.get('/api/thisweek', (req, res) => {
  const tracker = storage.getConfig('tracker.json', { stageThresholdDays: {} });
  const jobs = storage.jobs.list().filter(j => !['complete', 'invoiced'].includes(j.stage) || staleDays(j) < 30);
  const customersById = {};
  for (const c of storage.customers.list()) customersById[c.id] = c;

  const now = new Date();
  const weekEnd = new Date(now); weekEnd.setDate(now.getDate() + 7);

  const actions = [];
  const stale = [];
  for (const j of storage.jobs.list()) {
    if (['invoiced'].includes(j.stage)) continue;
    const cust = customersById[j.customerId] || {};
    if (j.nextAction && j.nextAction.text) {
      const due = j.nextAction.due ? new Date(j.nextAction.due) : null;
      const overdue = due && due < new Date(now.toDateString());
      const thisWeek = !due || due <= weekEnd;
      if (thisWeek) actions.push({ jobId: j.id, jobTitle: j.title, customer: cust.name || '', stage: j.stage, action: j.nextAction.text, due: j.nextAction.due || '', who: j.nextAction.who || j.responsible, overdue: !!overdue });
    }
    const threshold = tracker.stageThresholdDays[j.stage];
    const days = staleDays(j);
    if (threshold && days > threshold) {
      stale.push({ jobId: j.id, jobTitle: j.title, customer: cust.name || '', stage: j.stage, daysInStage: days, threshold });
    }
  }
  actions.sort((a, b) => (b.overdue - a.overdue) || (a.due || 'zzzz').localeCompare(b.due || 'zzzz'));
  res.json({ actions, stale });
});

function staleDays(job) {
  const last = job.stageHistory && job.stageHistory.length ? job.stageHistory[job.stageHistory.length - 1].date : job.createdAt;
  return Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
}

// ---- Customer update drafts ---------------------------------------------------

app.post('/api/jobs/:id/update-draft', (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  const customer = storage.customers.get(job.customerId) || {};
  const templates = storage.getConfig('update-templates.json', {});
  const biz = storage.getConfig('business.json', {});
  let msg = templates[job.stage] || 'Hi {firstName}, quick update on your {installType}: we are on to it and will be in touch shortly. {senderName}';
  const firstName = (customer.name || 'there').split(/[\s&,]+/)[0];
  msg = msg
    .replace(/\{firstName\}/g, firstName)
    .replace(/\{installType\}/g, job.installType || 'installation')
    .replace(/\{nextAction\}/g, (job.nextAction && job.nextAction.text) || '')
    .replace(/\{senderName\}/g, biz.senderName || biz.businessName || '');
  res.json({ message: msg });
});

app.post('/api/jobs/:id/updates-log', (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  job.updatesLog.push({ date: new Date().toISOString(), message: (req.body || {}).message || '' });
  storage.jobs.save(job);
  res.json(job.updatesLog);
});

// ---- Settings ----------------------------------------------------------------

app.get('/api/settings', (req, res) => {
  res.json({
    business: storage.getConfig('business.json', {}),
    tracker: storage.getConfig('tracker.json', { stageThresholdDays: {} }),
    updateTemplates: storage.getConfig('update-templates.json', {}),
    quoteChecklist: storage.getConfig('checklists/quote.json', []),
    specChecklist: storage.getConfig('checklists/spec.json', [])
  });
});

app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  if (b.business) storage.saveConfig('business.json', b.business);
  if (b.tracker) storage.saveConfig('tracker.json', b.tracker);
  if (b.updateTemplates) storage.saveConfig('update-templates.json', b.updateTemplates);
  if (b.quoteChecklist) storage.saveConfig('checklists/quote.json', b.quoteChecklist);
  if (b.specChecklist) storage.saveConfig('checklists/spec.json', b.specChecklist);
  res.json({ ok: true });
});

// ---- Spa catalogue -------------------------------------------------------------
// Models scraped from Spa World / Just Spas / Alpine Spas (scripts/build_catalogue.js)
// plus any the founder adds by hand. Picking a model fills the survey's spa
// dimensions and puts the product photo on the job.

const CATALOGUE_DIR = path.join(storage.DATA, 'catalogue');
const CATALOGUE_IMG_DIR = path.join(storage.DATA, 'catalogue-images');
const CATALOGUE_DOC_DIR = path.join(storage.DATA, 'catalogue-docs');
storage.ensureDir(CATALOGUE_DIR);
storage.ensureDir(CATALOGUE_IMG_DIR);
storage.ensureDir(CATALOGUE_DOC_DIR);
if (!filestore.isCloud) {
  app.use('/catalogue-images', express.static(CATALOGUE_IMG_DIR));
  app.use('/catalogue-docs', express.static(CATALOGUE_DOC_DIR));
}

const catalogueColl = storage.collection('catalogue');

function catalogueRecord(id) {
  return catalogueColl.get(String(id || '').replace(/[^a-zA-Z0-9_-]/g, ''));
}

app.get('/api/catalogue', (req, res) => {
  res.json(catalogueColl.list().sort((a, b) => (a.brand + a.name).localeCompare(b.brand + b.name)));
});

app.post('/api/catalogue', (req, res) => {
  const b = req.body || {};
  if (!(b.name || '').trim()) return err(res, 400, 'The model needs a name');
  const rec = {
    id: 'man_' + Date.now(),
    retailer: b.retailer || 'My own', brand: b.brand || '', name: b.name.trim(),
    type: b.type || 'spa', seats: b.seats || '',
    lengthM: b.lengthM || '', widthM: b.widthM || '', heightM: b.heightM || '',
    image: null, sourceUrl: b.sourceUrl || '', createdAt: new Date().toISOString()
  };
  catalogueColl.save(rec);
  res.json(rec);
});

app.put('/api/catalogue/:id', (req, res) => {
  const rec = catalogueRecord(req.params.id);
  if (!rec) return err(res, 404, 'Model not found');
  for (const k of ['brand', 'name', 'type', 'seats', 'lengthM', 'widthM', 'heightM', 'sourceUrl']) {
    if (req.body[k] !== undefined) rec[k] = req.body[k];
  }
  catalogueColl.save(rec);
  res.json(rec);
});

app.delete('/api/catalogue/:id', async (req, res) => {
  const rec = catalogueRecord(req.params.id);
  if (rec) {
    if (rec.image) await filestore.remove('catalogue-images', rec.image);
    catalogueColl.remove(rec.id);
  }
  res.json({ ok: true });
});

app.post('/api/catalogue/:id/image', upload.single('image'), async (req, res) => {
  const rec = catalogueRecord(req.params.id);
  if (!rec) return err(res, 404, 'Model not found');
  if (!req.file) return err(res, 400, 'No image received');
  const ext = (path.extname(req.file.originalname) || '.jpg').toLowerCase();
  const imgName = rec.id + ext;
  const buf = fs.readFileSync(req.file.path);
  await filestore.save('catalogue-images', imgName, buf, filestore.mimeFor(imgName));
  fs.unlinkSync(req.file.path);
  rec.image = imgName;
  catalogueColl.save(rec);
  res.json(rec);
});

// ---- Decking board library (Innowood, Millboard - scripts/build_decking.js) ----
const DECKING_DIR = path.join(storage.DATA, 'decking');
const DECKING_IMG_DIR = path.join(storage.DATA, 'decking-images');
storage.ensureDir(DECKING_DIR);
storage.ensureDir(DECKING_IMG_DIR);
if (!filestore.isCloud) {
  app.use('/decking-images', express.static(DECKING_IMG_DIR));
}

const deckingColl = storage.collection('decking');
app.get('/api/decking', (req, res) => {
  res.json(deckingColl.list().sort((a, b) =>
    (a.brand + a.range + a.name).localeCompare(b.brand + b.range + b.name)));
});

// ---- Owner-only area: passcode-locked actual costs and profit -----------------
// The passcode is stored as a salted hash in config/private.json (never the
// passcode itself). Unlocking returns a temporary token; every costs request
// must carry it. Cost data lives in data/private/, which no other screen or
// API endpoint ever reads, so future surveyors/coordinators never see it.

const crypto = require('crypto');
const privateTokens = new Map(); // token -> expiry (ms). Cleared on restart.
let unlockFailures = [];

const hashPasscode = (passcode, salt) => crypto.scryptSync(String(passcode), salt, 32).toString('hex');
const getPrivateConf = () => storage.getConfig('private.json', null);

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  privateTokens.set(token, Date.now() + 8 * 3600 * 1000);
  return { token };
}

function requirePrivate(req, res, next) {
  const exp = privateTokens.get(req.headers['x-private-token']);
  if (!exp || exp < Date.now()) return err(res, 401, 'Locked - enter the passcode');
  next();
}

app.get('/api/private/status', (req, res) => {
  const exp = privateTokens.get(req.headers['x-private-token']);
  res.json({ hasPasscode: !!getPrivateConf(), unlocked: !!(exp && exp > Date.now()) });
});

app.post('/api/private/setup', (req, res) => {
  if (getPrivateConf()) return err(res, 400, 'A passcode is already set');
  const pc = String((req.body || {}).passcode || '');
  if (pc.length < 4) return err(res, 400, 'Passcode needs at least 4 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  storage.saveConfig('private.json', { salt, hash: hashPasscode(pc, salt) });
  res.json(issueToken());
});

app.post('/api/private/unlock', (req, res) => {
  const conf = getPrivateConf();
  if (!conf) return err(res, 400, 'No passcode set yet');
  unlockFailures = unlockFailures.filter(t => t > Date.now() - 60000);
  if (unlockFailures.length >= 5) return err(res, 429, 'Too many tries - wait a minute and try again');
  if (hashPasscode(String((req.body || {}).passcode || ''), conf.salt) !== conf.hash) {
    unlockFailures.push(Date.now());
    return err(res, 401, 'Wrong passcode');
  }
  res.json(issueToken());
});

app.post('/api/private/change', (req, res) => {
  const conf = getPrivateConf();
  if (!conf) return err(res, 400, 'No passcode set yet');
  const b = req.body || {};
  if (hashPasscode(String(b.passcode || ''), conf.salt) !== conf.hash) return err(res, 401, 'Wrong current passcode');
  if (String(b.newPasscode || '').length < 4) return err(res, 400, 'New passcode needs at least 4 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  storage.saveConfig('private.json', { salt, hash: hashPasscode(String(b.newPasscode), salt) });
  privateTokens.clear(); // everyone re-enters the new passcode
  res.json(issueToken());
});

// Costs live in their own collection ('private'), which no ordinary screen or
// endpoint ever reads. Locally that's the data/private folder; in the cloud
// it's rows in the same protected database.
const privateColl = storage.collection('private');

// Costs for a job: one row per line item of the accepted (or latest) quote,
// with the actual cost typed in as the job runs, plus unplanned extras.
app.get('/api/private/costs/:jobId', requirePrivate, (req, res) => {
  const job = storage.jobs.get(req.params.jobId);
  if (!job) return err(res, 404, 'Job not found');
  const record = privateColl.get('costs_' + job.id) || { id: 'costs_' + job.id, jobId: job.id, items: [], extras: [] };
  const quotes = storage.quotes.list().filter(q => q.jobId === job.id);
  const quote = quotes.find(q => q.status === 'accepted') || quotes[quotes.length - 1] || null;
  if (quote) {
    const seen = {};
    for (const li of (quote.lineItems || []).filter(l => l.included !== false)) {
      const key = li.code + '|' + li.description;
      seen[key] = true;
      let item = record.items.find(i => i.key === key);
      if (!item) { item = { key, cost: '', notes: '' }; record.items.push(item); }
      item.description = li.description;
      item.trade = li.trade;
      item.sellEx = Math.round((parseFloat(li.qty) || 0) * (parseFloat(li.unitPrice) || 0) * 100) / 100;
      item.inQuote = true;
    }
    for (const i of record.items) if (!seen[i.key]) i.inQuote = false;
  }
  record.quote = quote ? { id: quote.id, status: quote.status, totals: quoteTotals(quote) } : null;
  res.json(record);
});

app.put('/api/private/costs/:jobId', requirePrivate, (req, res) => {
  const job = storage.jobs.get(req.params.jobId);
  if (!job) return err(res, 404, 'Job not found');
  const b = req.body || {};
  const record = { id: 'costs_' + job.id, jobId: job.id, items: b.items || [], extras: b.extras || [] };
  privateColl.save(record);
  res.json(record);
});

app.get('/api/meta', (req, res) => {
  res.json({
    stages: STAGES,
    trades: ['concrete', 'plumbing', 'electrical', 'excavation', 'crane', 'general'].map(t => ({ id: t, label: tradeLabel(t) })),
    cloud: storage.IS_CLOUD,
    transcribe: !process.env.DISABLE_TRANSCRIBE,
    loginRequired: !!APP_PASSWORD
  });
});

// In cloud mode the database must be loaded before we take requests.
storage.ready().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('  Spa Jobs is running' + (storage.IS_CLOUD ? ' (cloud mode).' : '.'));
    console.log('  Open this in your browser:  http://localhost:' + PORT);
    if (!storage.IS_CLOUD) {
      console.log('  (On your phone, use this computer\'s address, e.g. http://192.168.x.x:' + PORT + ')');
    }
    console.log('');
  });

  // HTTPS twin for the Meta Quest headset - local mode only (the hosted
  // version gets real HTTPS from the platform).
  if (process.env.CLOUD) return;
  const HTTPS_PORT = process.env.HTTPS_PORT || (Number(PORT) + 1);
  try {
    const https = require('https');
    const { execSync } = require('child_process');
    const sslDir = path.join(__dirname, 'config', 'ssl');
    const keyFile = path.join(sslDir, 'key.pem');
    const certFile = path.join(sslDir, 'cert.pem');
    if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
      fs.mkdirSync(sslDir, { recursive: true });
      execSync('openssl req -x509 -newkey rsa:2048 -keyout "' + keyFile + '" -out "' + certFile +
        '" -days 3650 -nodes -subj "/CN=spa-jobs.local"', { stdio: 'ignore' });
    }
    https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, app)
      .listen(HTTPS_PORT, () => {
        console.log('  For the Meta Quest headset (same wifi):  https://<this computer\'s address>:' + HTTPS_PORT);
        console.log('  (The headset will warn about the certificate once - choose Advanced, then Proceed.)');
        console.log('');
      });
  } catch (e) {
    console.log('  (https for the VR headset not available: ' + e.message + ')');
  }
}).catch(e => {
  console.error('Could not connect to the database:', e.message);
  process.exit(1);
});
