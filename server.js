// Spa Jobs - site survey, quoting and job management.
// Start with: npm start   (then open http://localhost:4321)

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const storage = require('./lib/storage');
const { prefillLineItems, buildScopeDescription, quoteTotals } = require('./lib/prefill');
const { buildSpec, tradeLabel } = require('./lib/specgen');
const { runChecks } = require('./lib/checks');
const pdf = require('./lib/pdf');
const { structureNotes } = require('./lib/transcribe');

const app = express();
const PORT = process.env.PORT || 4321;

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(storage.uploadsDir));

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

app.post('/api/jobs/:id/documents', upload.single('file'), (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  if (!req.file) return err(res, 400, 'No file received');
  job.documents = job.documents || [];
  job.documents.push({
    label: (req.body.label || req.file.originalname).trim(),
    file: req.file.filename,
    addedAt: new Date().toISOString()
  });
  storage.jobs.save(job);
  res.json(job.documents);
});

app.delete('/api/jobs/:id/documents/:file', (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  const safe = req.params.file.replace(/[^a-zA-Z0-9._-]/g, '');
  job.documents = (job.documents || []).filter(d => d.file !== safe);
  const full = path.join(storage.uploadsDir, safe);
  if (fs.existsSync(full)) fs.unlinkSync(full);
  storage.jobs.save(job);
  res.json(job.documents);
});

// ---- Survey uploads ---------------------------------------------------------

app.post('/api/jobs/:id/photos', upload.single('photo'), (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  if (!req.file) return err(res, 400, 'No photo received');
  job.survey = job.survey || emptySurvey();
  const photo = { id: storage.newId('photo'), file: req.file.filename, annotatedFile: null, caption: req.body.caption || '' };
  job.survey.photos.push(photo);
  storage.jobs.save(job);
  res.json(photo);
});

// Annotated version arrives as a data-URL PNG from the drawing canvas.
app.post('/api/jobs/:id/photos/:photoId/annotate', (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job || !job.survey) return err(res, 404, 'Job or survey not found');
  const photo = job.survey.photos.find(p => p.id === req.params.photoId);
  if (!photo) return err(res, 404, 'Photo not found');
  const dataUrl = (req.body || {}).dataUrl || '';
  const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!m) return err(res, 400, 'Expected a PNG data URL');
  const filename = 'annotated_' + photo.id + '.png';
  fs.writeFileSync(path.join(storage.uploadsDir, filename), Buffer.from(m[1], 'base64'));
  photo.annotatedFile = filename;
  storage.jobs.save(job);
  res.json(photo);
});

app.post('/api/jobs/:id/sketch', (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  job.survey = job.survey || emptySurvey();
  const m = ((req.body || {}).dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
  if (!m) return err(res, 400, 'Expected a PNG data URL');
  const filename = 'sketch_' + job.id + '_' + Date.now() + '.png';
  fs.writeFileSync(path.join(storage.uploadsDir, filename), Buffer.from(m[1], 'base64'));
  job.survey.sketch = { file: filename };
  storage.jobs.save(job);
  res.json(job.survey.sketch);
});

// 3D scan of the yard - shown in the 3D viewer. Takes a .glb / .gltf straight,
// or the .zip Polycam exports (model plus its texture files) and unpacks it.
app.post('/api/jobs/:id/scan', upload.single('scan'), (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  if (!req.file) return err(res, 400, 'No scan file received');
  let scanFile = req.file.filename;
  if (/\.zip$/i.test(scanFile)) {
    try {
      const { execSync } = require('child_process');
      const dir = 'scan_' + job.id + '_' + Date.now();
      const dirPath = path.join(storage.uploadsDir, dir);
      execSync('unzip -o ' + JSON.stringify(path.join(storage.uploadsDir, scanFile)) + ' -d ' + JSON.stringify(dirPath), { stdio: 'ignore' });
      fs.unlinkSync(path.join(storage.uploadsDir, scanFile));
      // find the model inside - .glb first, else .gltf (textures sit alongside)
      const found = findModelFile(dirPath, dirPath);
      if (!found) return err(res, 400, 'No 3D model found inside that zip. In Polycam, export as GLTF (not raw data).');
      scanFile = dir + '/' + found;
    } catch (e) {
      return err(res, 500, 'Could not unpack the zip: ' + e.message);
    }
  } else if (!/\.(glb|gltf)$/i.test(scanFile)) {
    return err(res, 400, 'Upload the scan as GLTF/GLB, or the zip that Polycam exports.');
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

app.post('/api/jobs/:id/video', upload.single('video'), (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job) return err(res, 404, 'Job not found');
  if (!req.file) return err(res, 400, 'No video received');
  job.survey = job.survey || emptySurvey();
  job.survey.video.file = req.file.filename;
  storage.jobs.save(job);
  res.json(job.survey.video);
});

app.post('/api/jobs/:id/transcribe', async (req, res) => {
  const job = storage.jobs.get(req.params.id);
  if (!job || !job.survey || !job.survey.video.file) return err(res, 400, 'Upload a video first');
  try {
    const { transcribe } = require('./lib/transcribe');
    const text = await transcribe(path.join(storage.uploadsDir, job.survey.video.file));
    job.survey.video.transcript = text;
    job.survey.video.structuredNotes = structureNotes(text);
    storage.jobs.save(job);
    res.json(job.survey.video);
  } catch (e) {
    err(res, 500, 'Transcription did not work (' + e.message + '). You can type or paste the notes instead - the Structure Notes button still works on typed text.');
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
  const quote = {
    id: storage.newId('quote'),
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
      const full = path.join(CATALOGUE_DOC_DIR, cat.docFile);
      if (fs.existsSync(full)) attachments.push({ path: full, type: 'pdf' });
    }
  }
  for (const f of s.attachDocs || []) {
    const d = ((job && job.documents) || []).find(x => x.file === f);
    if (!d) continue;
    const full = path.join(storage.uploadsDir, d.file);
    if (!fs.existsSync(full)) continue;
    const ext = path.extname(d.file).toLowerCase();
    const type = ext === '.pdf' ? 'pdf' : ext === '.png' ? 'png' : (ext === '.jpg' || ext === '.jpeg') ? 'jpg' : null;
    if (type) attachments.push({ path: full, type });
  }
  if (attachments.length) {
    try {
      const { PDFDocument } = require('pdf-lib');
      const merged = await PDFDocument.load(buffer);
      for (const a of attachments) {
        const bytes = fs.readFileSync(a.path);
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
app.use('/catalogue-images', express.static(CATALOGUE_IMG_DIR));
app.use('/catalogue-docs', express.static(CATALOGUE_DOC_DIR));

function catalogueRecord(id) {
  const file = path.join(CATALOGUE_DIR, String(id || '').replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
  return fs.existsSync(file) ? storage.readJson(file) : null;
}

function listCatalogue() {
  return fs.readdirSync(CATALOGUE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => storage.readJson(path.join(CATALOGUE_DIR, f)))
    .sort((a, b) => (a.brand + a.name).localeCompare(b.brand + b.name));
}

app.get('/api/catalogue', (req, res) => res.json(listCatalogue()));

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
  storage.writeJson(path.join(CATALOGUE_DIR, rec.id + '.json'), rec);
  res.json(rec);
});

app.put('/api/catalogue/:id', (req, res) => {
  const file = path.join(CATALOGUE_DIR, req.params.id.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
  if (!fs.existsSync(file)) return err(res, 404, 'Model not found');
  const rec = storage.readJson(file);
  for (const k of ['brand', 'name', 'type', 'seats', 'lengthM', 'widthM', 'heightM', 'sourceUrl']) {
    if (req.body[k] !== undefined) rec[k] = req.body[k];
  }
  rec.updatedAt = new Date().toISOString();
  storage.writeJson(file, rec);
  res.json(rec);
});

app.delete('/api/catalogue/:id', (req, res) => {
  const safe = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(CATALOGUE_DIR, safe + '.json');
  if (fs.existsSync(file)) {
    const rec = storage.readJson(file);
    if (rec.image && fs.existsSync(path.join(CATALOGUE_IMG_DIR, rec.image))) {
      fs.unlinkSync(path.join(CATALOGUE_IMG_DIR, rec.image));
    }
    fs.unlinkSync(file);
  }
  res.json({ ok: true });
});

app.post('/api/catalogue/:id/image', upload.single('image'), (req, res) => {
  const safe = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(CATALOGUE_DIR, safe + '.json');
  if (!fs.existsSync(file)) return err(res, 404, 'Model not found');
  if (!req.file) return err(res, 400, 'No image received');
  const rec = storage.readJson(file);
  const ext = (path.extname(req.file.originalname) || '.jpg').toLowerCase();
  const imgName = safe + ext;
  fs.renameSync(req.file.path, path.join(CATALOGUE_IMG_DIR, imgName));
  rec.image = imgName;
  storage.writeJson(file, rec);
  res.json(rec);
});

// ---- Decking board library (Innowood, Millboard - scripts/build_decking.js) ----
const DECKING_DIR = path.join(storage.DATA, 'decking');
const DECKING_IMG_DIR = path.join(storage.DATA, 'decking-images');
storage.ensureDir(DECKING_DIR);
storage.ensureDir(DECKING_IMG_DIR);
app.use('/decking-images', express.static(DECKING_IMG_DIR));

app.get('/api/decking', (req, res) => {
  const list = fs.readdirSync(DECKING_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => storage.readJson(path.join(DECKING_DIR, f)))
    .sort((a, b) => (a.brand + a.range + a.name).localeCompare(b.brand + b.range + b.name));
  res.json(list);
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

const PRIVATE_DIR = path.join(storage.DATA, 'private');

// Costs for a job: one row per line item of the accepted (or latest) quote,
// with the actual cost typed in as the job runs, plus unplanned extras.
app.get('/api/private/costs/:jobId', requirePrivate, (req, res) => {
  const job = storage.jobs.get(req.params.jobId);
  if (!job) return err(res, 404, 'Job not found');
  const file = path.join(PRIVATE_DIR, 'costs_' + job.id + '.json');
  const record = storage.readJson(file, { jobId: job.id, items: [], extras: [] });
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
  const record = { jobId: job.id, items: b.items || [], extras: b.extras || [], updatedAt: new Date().toISOString() };
  storage.writeJson(path.join(PRIVATE_DIR, 'costs_' + job.id + '.json'), record);
  res.json(record);
});

app.get('/api/meta', (req, res) => {
  res.json({ stages: STAGES, trades: ['concrete', 'plumbing', 'electrical', 'excavation', 'crane', 'general'].map(t => ({ id: t, label: tradeLabel(t) })) });
});

app.listen(PORT, () => {
  console.log('');
  console.log('  Spa Jobs is running.');
  console.log('  Open this in your browser:  http://localhost:' + PORT);
  console.log('  (On your phone, use this computer\'s address, e.g. http://192.168.x.x:' + PORT + ')');
  console.log('');
});

// HTTPS twin of the same app. Only needed for the Meta Quest headset: the
// Quest browser refuses VR/AR on plain http. Uses a self-signed certificate
// generated on first start - the headset shows a warning once, choose
// "Advanced" then "Proceed" and it works from then on.
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
