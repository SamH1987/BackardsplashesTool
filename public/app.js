/* Spa Jobs frontend. Plain JavaScript, no build step.
   One hash-router, one view function per screen. */

// ---------- small helpers ----------
const $ = s => document.querySelector(s);
const view = () => $('#view');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && (data.error || '') === 'login required') {
    location.href = '/login.html';
    throw new Error('login required');
  }
  if (!res.ok) {
    const e = new Error(data.error || ('Request failed (' + res.status + ')'));
    e.data = data;
    throw e;
  }
  return data;
}

let toastTimer = null;
function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 2500);
}

// One-tap "Add to Google Calendar" link: opens Gmail's calendar with the event
// pre-filled as an all-day entry, so Google's own reminders kick in.
function gcalUrl(title, dateStr, details) {
  const d1 = dateStr.replace(/-/g, '');
  const next = new Date(dateStr + 'T12:00:00');
  next.setDate(next.getDate() + 1);
  const d2 = next.toISOString().slice(0, 10).replace(/-/g, '');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(title) +
    '&dates=' + d1 + '/' + d2 + '&details=' + encodeURIComponent(details || 'From Spa Jobs');
}

function fmtD(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- offline support ----------
// The service worker caches the app and everything you've looked at, so it
// all opens with no signal. Changes made offline land in this queue and sync
// to the office computer as soon as a connection comes back.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('spajobs-offline', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('queue');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function queuePut(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function queueDelete(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function queueAll() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const out = [];
    const cur = db.transaction('queue').objectStore('queue').openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { out.push({ key: c.key, value: c.value }); c.continue(); } else resolve(out);
    };
    cur.onerror = () => reject(cur.error);
  });
}
function isNetworkError(e) {
  return e instanceof TypeError || /fetch|network|load failed/i.test(e.message || '');
}
function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

let syncing = false;
async function syncQueue() {
  if (syncing) return;
  syncing = true;
  try {
    const items = await queueAll();
    if (!items.length) return;
    const order = { survey: 0, photo: 1, sketch: 2 };
    items.sort((a, b) => (order[a.value.kind] || 9) - (order[b.value.kind] || 9));
    let done = 0;
    for (const { key, value } of items) {
      if (value.kind === 'survey') {
        await api('PUT', '/api/jobs/' + value.jobId, value.body);
      } else if (value.kind === 'photo') {
        const fd = new FormData();
        fd.append('photo', dataUrlToBlob(value.dataUrl), 'offline_photo_' + Date.now() + '.jpg');
        fd.append('caption', value.caption || '');
        const r = await fetch('/api/jobs/' + value.jobId + '/photos', { method: 'POST', body: fd });
        if (!r.ok) throw new Error('photo upload failed');
      } else if (value.kind === 'sketch') {
        await api('POST', '/api/jobs/' + value.jobId + '/sketch', { dataUrl: value.dataUrl });
      }
      await queueDelete(key);
      done++;
    }
    if (done) toast(done + ' offline change' + (done === 1 ? '' : 's') + ' synced to the office computer');
  } catch (e) { /* still out of range - everything stays queued */ }
  finally { syncing = false; }
}
window.addEventListener('online', () => setTimeout(syncQueue, 1500));
setTimeout(syncQueue, 3000);

// Warm the offline cache whenever the app opens with a connection: every job,
// its survey photos and the key lists get cached so the whole lot still opens
// in a dead spot later.
async function warmOfflineCache() {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  try {
    const jobs = await fetch('/api/jobs').then(r => r.json());
    const warm = ['/api/thisweek', '/api/customers', '/api/catalogue', '/api/decking', '/api/meta', '/api/empty-survey', '/api/settings'];
    for (const j of jobs) {
      warm.push('/api/jobs/' + j.id);
      const s = j.survey;
      if (!s) continue;
      for (const p of (s.photos || [])) {
        if (p.file) warm.push('/uploads/' + p.file);
        if (p.annotatedFile) warm.push('/uploads/' + p.annotatedFile);
      }
      if (s.sketch && s.sketch.file) warm.push('/uploads/' + s.sketch.file);
      if (s.spaModel && s.spaModel.image) warm.push('/catalogue-images/' + s.spaModel.image);
    }
    warm.forEach(u => { fetch(u).catch(() => {}); });
  } catch (e) { /* offline right now - nothing to warm */ }
}
setTimeout(warmOfflineCache, 4000);

const STAGES = ['lead', 'survey_done', 'quote_sent', 'accepted', 'contractors_booked', 'in_progress', 'complete', 'invoiced'];
const STAGE_LABELS = {
  lead: 'New lead', survey_done: 'Survey done', quote_sent: 'Quote sent', accepted: 'Accepted',
  contractors_booked: 'Trades booked', in_progress: 'On site', complete: 'Finished', invoiced: 'Invoiced'
};
const APPROVAL_LABELS = {
  not_checked: 'Approval not checked yet', not_required: 'No approval required',
  lodged: 'Approval lodged', approved: 'Approval in place'
};
const TRADE_LABELS = { concrete: 'Concrete', plumbing: 'Plumbing', electrical: 'Electrical', excavation: 'Excavation', crane: 'Crane / lift', general: 'General works' };
const QUOTE_STATUS_BADGE = { draft: '', sent: 'blue', accepted: 'green', declined: 'red' };
const INVOICE_STATUS_BADGE = { draft: '', sent: 'blue', paid: 'green' };

// ---------- router ----------
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

async function route() {
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/').filter(Boolean); // after "#/"
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.remove('active'));
  const navKey = parts[0] === '' || parts.length === 0 ? 'home'
    : ['jobs', 'job', 'quote', 'spec'].includes(parts[0]) ? 'jobs'
    : ['customers', 'customer'].includes(parts[0]) ? 'customers'
    : ['invoices', 'invoice'].includes(parts[0]) ? 'invoices'
    : ['settings', 'templates', 'template', 'catalogue'].includes(parts[0]) ? 'settings' : 'home';
  const navEl = document.querySelector('[data-nav="' + navKey + '"]');
  if (navEl) navEl.classList.add('active');
  try {
    if (parts.length === 0) return viewThisWeek();
    if (parts[0] === 'jobs') return viewJobs();
    if (parts[0] === 'customers') return viewCustomers();
    if (parts[0] === 'customer') return viewCustomer(parts[1]);
    if (parts[0] === 'job' && parts[2] === 'survey') return viewSurvey(parts[1]);
    if (parts[0] === 'job' && parts[2] === 'costs') return viewCosts(parts[1]);
    if (parts[0] === 'job') return viewJob(parts[1]);
    if (parts[0] === 'quote') return viewQuote(parts[1]);
    if (parts[0] === 'spec') return viewSpec(parts[1]);
    if (parts[0] === 'invoices') return viewInvoices();
    if (parts[0] === 'invoice') return viewInvoice(parts[1]);
    if (parts[0] === 'settings') return viewSettings();
    if (parts[0] === 'templates') return viewTemplates();
    if (parts[0] === 'catalogue') return viewCatalogue();
    if (parts[0] === 'template') return viewTemplate(parts[1]);
    viewThisWeek();
  } catch (e) {
    view().innerHTML = '<div class="card"><p>Something went wrong: ' + esc(e.message) + '</p></div>';
  }
}

// ---------- This week ----------
async function viewThisWeek() {
  const [tw, jobs, customers] = await Promise.all([api('GET', '/api/thisweek'), api('GET', '/api/jobs'), api('GET', '/api/customers')]);
  const custById = {}; customers.forEach(c => custById[c.id] = c);
  const active = jobs.filter(j => !['invoiced'].includes(j.stage));

  let html = '<div class="card"><h2>This week</h2>';
  if (!tw.actions.length) html += '<p class="muted">Nothing due. Add next actions on your jobs so nothing slips.</p>';
  for (const a of tw.actions) {
    html += `<div class="action-line">
      <span class="due ${a.overdue ? 'overdue' : ''}">${a.overdue ? 'OVERDUE' : (a.due ? fmtD(a.due) : 'no date')}</span>
      <span class="grow"><a class="title" href="#/job/${a.jobId}">${esc(a.customer)} - ${esc(a.jobTitle)}</a><br>
      <span class="small">${esc(a.action)} <span class="muted">(${esc(a.who)})</span></span></span>
      ${a.due ? `<a class="btn secondary small-btn" target="_blank" title="Add to Google Calendar" href="${gcalUrl(esc(a.customer) + ': ' + esc(a.action), a.due, 'Job: ' + esc(a.jobTitle))}">Calendar</a>` : ''}
      <span class="badge">${STAGE_LABELS[a.stage] || a.stage}</span>
      <button class="small-btn secondary" data-del-job="${a.jobId}" title="Delete job">x</button>
    </div>`;
  }
  html += '</div>';

  if (tw.stale.length) {
    html += '<div class="card"><h2>Sitting too long</h2><p class="muted small">These jobs have been in the same stage past your limit (set in Settings).</p>';
    for (const s of tw.stale) {
      html += `<div class="action-line">
        <span class="badge red">${s.daysInStage} days</span>
        <span class="grow"><a class="title" href="#/job/${s.jobId}">${esc(s.customer)} - ${esc(s.jobTitle)}</a><br>
        <span class="small muted">In "${STAGE_LABELS[s.stage] || s.stage}" - your limit is ${s.threshold} days</span></span>
        <button class="small-btn secondary" data-del-job="${s.jobId}" title="Delete job">x</button>
      </div>`;
    }
    html += '</div>';
  }

  html += '<div class="card"><h2>All active jobs</h2>';
  if (!active.length) html += '<p class="muted">No jobs yet. Start from the Customers screen.</p>';
  for (const j of active) {
    const c = custById[j.customerId] || {};
    html += jobLine(j, c);
  }
  html += '</div>';
  view().innerHTML = html;
  wireJobDeletes(viewThisWeek);
}

function jobLine(j, c) {
  return `<div class="item-row">
    <span class="grow"><a class="title" href="#/job/${j.id}">${esc(c.name || '')} - ${esc(j.title)}</a><br>
    <span class="small muted">${esc(j.siteAddress || '')}</span></span>
    <span class="badge blue">${STAGE_LABELS[j.stage] || j.stage}</span>
    <button class="small-btn secondary" data-del-job="${j.id}" title="Delete job">x</button>
  </div>`;
}

// Shared by every screen that lists jobs via action-lines or jobLine().
// refresh is called after a successful delete so the list re-renders.
function wireJobDeletes(refresh) {
  document.querySelectorAll('[data-del-job]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this job? This can\'t be undone - its quotes, specs and invoices go with it.')) return;
    try {
      await api('DELETE', '/api/jobs/' + b.dataset.delJob);
      refresh();
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- Jobs list ----------
async function viewJobs() {
  const [jobs, customers] = await Promise.all([api('GET', '/api/jobs'), api('GET', '/api/customers')]);
  const custById = {}; customers.forEach(c => custById[c.id] = c);
  let html = '';
  for (const stage of STAGES) {
    const inStage = jobs.filter(j => j.stage === stage);
    if (!inStage.length) continue;
    html += `<div class="card"><h2>${STAGE_LABELS[stage]}</h2>`;
    for (const j of inStage) html += jobLine(j, custById[j.customerId] || {});
    html += '</div>';
  }
  if (!html) html = '<div class="card"><p class="muted">No jobs yet. Add a customer first, then start a job from their page.</p></div>';
  view().innerHTML = '<div class="row" style="margin-top:12px"><a class="btn" href="#/customers">+ New job (via customer)</a></div>' + html;
  wireJobDeletes(viewJobs);
}

// ---------- Customers ----------
async function viewCustomers() {
  const customers = await api('GET', '/api/customers');
  let html = `<div class="card"><h2>Customers</h2>`;
  if (!customers.length) html += '<p class="muted">No customers yet - add the first one below.</p>';
  for (const c of customers) {
    html += `<div class="item-row">
      <span class="grow"><a class="title" href="#/customer/${c.id}">${esc(c.name)}</a><br>
      <span class="small muted">${esc(c.address || '')} ${esc(c.phone || '')}</span></span>
    </div>`;
  }
  html += `</div>
  <div class="card"><h2>Add a customer</h2>
    <label class="field"><span>Name</span><input type="text" id="nc-name" placeholder="e.g. Karen &amp; David Mitchell"></label>
    <label class="field"><span>Phone</span><input type="tel" id="nc-phone"></label>
    <label class="field"><span>Email</span><input type="email" id="nc-email"></label>
    <label class="field"><span>Address</span><input type="text" id="nc-address"></label>
    <button id="nc-save">Save customer</button>
  </div>`;
  view().innerHTML = html;
  $('#nc-save').onclick = async () => {
    try {
      const c = await api('POST', '/api/customers', {
        name: $('#nc-name').value, phone: $('#nc-phone').value,
        email: $('#nc-email').value, address: $('#nc-address').value
      });
      location.hash = '#/customer/' + c.id;
    } catch (e) { toast(e.message, true); }
  };
}

async function viewCustomer(id) {
  const [customers, jobs, templates] = await Promise.all([
    api('GET', '/api/customers'), api('GET', '/api/jobs?customerId=' + id), api('GET', '/api/templates')
  ]);
  const c = customers.find(x => x.id === id);
  if (!c) { view().innerHTML = '<div class="card">Customer not found.</div>'; return; }
  const types = [...new Set(templates.map(t => t.installType).filter(Boolean))];
  let html = `<div class="card"><h2>${esc(c.name)}</h2>
    <label class="field"><span>Name</span><input type="text" id="c-name" value="${esc(c.name)}"></label>
    <label class="field"><span>Phone</span><input type="tel" id="c-phone" value="${esc(c.phone)}"></label>
    <label class="field"><span>Email</span><input type="email" id="c-email" value="${esc(c.email)}"></label>
    <label class="field"><span>Address</span><input type="text" id="c-address" value="${esc(c.address)}"></label>
    <label class="field"><span>Notes</span><textarea id="c-notes">${esc(c.notes)}</textarea></label>
    <div class="row">
      <button id="c-save">Save details</button>
      <button id="c-delete" class="danger">Delete customer</button>
    </div>
  </div>
  <div class="card"><h2>Jobs for this customer</h2>`;
  if (!jobs.length) html += '<p class="muted">No jobs yet.</p>';
  for (const j of jobs) html += jobLine(j, c);
  html += `<hr>
    <h3>Start a new job</h3>
    <label class="field"><span>What is it? (short title)</span><input type="text" id="nj-title" placeholder="e.g. In-ground spa, back yard"></label>
    <label class="field"><span>Install type</span>
      <select id="nj-type"><option value="">Pick one...</option>${types.map(t => `<option>${esc(t)}</option>`).join('')}<option>semi-inground spa</option><option value="__other">Other</option></select></label>
    <label class="field"><span>Site address (if different from home address)</span><input type="text" id="nj-address" value="${esc(c.address)}"></label>
    <button id="nj-save">Start job</button>
  </div>`;
  view().innerHTML = html;
  wireJobDeletes(() => viewCustomer(id));
  $('#c-save').onclick = async () => {
    try {
      await api('PUT', '/api/customers/' + c.id, {
        name: $('#c-name').value, phone: $('#c-phone').value, email: $('#c-email').value,
        address: $('#c-address').value, notes: $('#c-notes').value
      });
      toast('Saved');
    } catch (e) { toast(e.message, true); }
  };
  $('#c-delete').onclick = async () => {
    const warning = jobs.length
      ? 'Delete ' + c.name + '? This can\'t be undone. They have ' + jobs.length + ' job' + (jobs.length === 1 ? '' : 's') + ' on file - those will stay, just without a linked customer.'
      : 'Delete ' + c.name + '? This can\'t be undone.';
    if (!confirm(warning)) return;
    try {
      await api('DELETE', '/api/customers/' + c.id);
      location.hash = '#/customers';
    } catch (e) { toast(e.message, true); }
  };
  $('#nj-save').onclick = async () => {
    try {
      let type = $('#nj-type').value;
      if (type === '__other') type = prompt('Install type:') || '';
      const j = await api('POST', '/api/jobs', {
        customerId: c.id, title: $('#nj-title').value || 'New job',
        installType: type, siteAddress: $('#nj-address').value
      });
      location.hash = '#/job/' + j.id;
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- Job overview ----------
async function viewJob(id) {
  const job = await api('GET', '/api/jobs/' + id);
  const [customers, quotes, specs, templates] = await Promise.all([
    api('GET', '/api/customers'), api('GET', '/api/quotes?jobId=' + id),
    api('GET', '/api/specs?jobId=' + id), api('GET', '/api/templates')
  ]);
  const c = customers.find(x => x.id === job.customerId) || {};
  const currentIdx = STAGES.indexOf(job.stage);

  let html = `<div class="card">
    <h2><a href="#/customer/${c.id}" style="color:inherit;text-decoration:none">${esc(c.name)}</a> - ${esc(job.title)}</h2>
    <p class="muted">${esc(job.siteAddress || '')} ${c.phone ? ' | ' + esc(c.phone) : ''}
      <a href="#/customer/${c.id}" class="small" style="color:var(--blue);font-weight:600"> Edit customer details</a></p>
    <div class="stage-board">${STAGES.map((s, i) =>
      `<div class="stage-chip ${i < currentIdx ? 'done' : ''} ${i === currentIdx ? 'current' : ''}" data-stage="${s}">${STAGE_LABELS[s]}</div>`).join('')}
    </div>
    <p class="small muted">Tap a stage to move the job. Stage changed: ${fmtD(job.stageHistory[job.stageHistory.length - 1].date)}</p>
    <div class="row">
      <label class="field grow"><span>Council / approval status</span>
        <select id="j-approval">${Object.keys(APPROVAL_LABELS).map(k =>
          `<option value="${k}" ${job.approvalStatus === k ? 'selected' : ''}>${APPROVAL_LABELS[k]}</option>`).join('')}</select></label>
      <label class="field grow"><span>Who runs this job</span><input type="text" id="j-resp" value="${esc(job.responsible)}"></label>
    </div>
  </div>

  <div class="card"><h2>Next action (never leave this empty)</h2>
    <label class="field"><span>What happens next?</span><input type="text" id="na-text" value="${esc(job.nextAction.text)}"></label>
    <div class="row">
      <label class="field grow"><span>By when</span><input type="date" id="na-due" value="${esc(job.nextAction.due)}"></label>
      <label class="field grow"><span>Whose job is it</span><input type="text" id="na-who" value="${esc(job.nextAction.who || job.responsible)}"></label>
    </div>
    <div class="row">
      <button id="na-save">Save next action</button>
      ${job.nextAction.due ? `<a class="btn secondary" target="_blank" href="${gcalUrl(esc(c.name) + ': ' + esc(job.nextAction.text), job.nextAction.due, 'Job: ' + esc(job.title) + ' - ' + esc(job.siteAddress || ''))}">Add to Google Calendar</a>` : '<span class="small muted">Set a date to add it to your Google Calendar</span>'}
    </div>
  </div>

  <div class="card"><h2>Site survey</h2>
    ${job.survey ? `<p>Survey saved ${esc(job.survey.date || '')} by ${esc(job.survey.completedBy || 'unknown')}.
      ${job.survey.photos.length} photos, ${(job.survey.video && job.survey.video.transcript) ? 'walkthrough transcribed' : 'no walkthrough yet'}.</p>
      <div class="row">
        <a class="btn" href="#/job/${job.id}/survey">Open survey</a>
        <a class="btn secondary" href="/3d.html?job=${job.id}" target="_blank">3D view (show the customer)</a>
      </div>`
      : `<p class="muted">Not done yet. Do this on site - phone or tablet.</p>
      <div class="row">
        <a class="btn" href="#/job/${job.id}/survey">Start site survey</a>
        <a class="btn secondary" href="/3d.html?job=${job.id}" target="_blank">3D view (standard sizes - adjust on screen)</a>
      </div>`}
  </div>

  <div class="card"><h2>Quotes</h2>`;
  for (const q of quotes) {
    html += `<div class="item-row">
      <span class="grow"><a class="title" href="#/quote/${q.id}">${esc(q.templateName)}</a><br>
      <span class="small muted">${money(q.totals.total)} incl GST | created ${fmtD(q.dates.created)}</span></span>
      <span class="badge ${QUOTE_STATUS_BADGE[q.status]}">${q.status}</span>
      <a class="btn secondary small-btn" href="/api/quotes/${q.id}/pdf" target="_blank">PDF</a>
    </div>`;
  }
  html += `${quotes.length ? '' : '<p class="muted">No quotes yet.</p>'}
    <div class="row">
      <select id="q-template" class="grow">${templates.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <button id="q-new">New quote from template</button>
    </div>
    ${job.survey ? '' : '<p class="small muted">Tip: do the site survey first - the quote pre-fills from it.</p>'}
  </div>

  <div class="card"><h2>Contractor specs</h2>`;
  for (const s of specs) {
    html += `<div class="item-row">
      <span class="grow"><a class="title" href="#/spec/${s.id}">${esc(s.tradeLabel || s.trade)}</a></span>
      <span class="badge ${s.status === 'final' ? 'green' : ''}">${s.status}</span>
      <a class="btn secondary small-btn" href="/api/specs/${s.id}/pdf" target="_blank">PDF</a>
    </div>`;
  }
  html += `${specs.length ? '' : '<p class="muted">One sheet per trade. Uses the accepted quote, or the latest quote if nothing is accepted yet - handy for getting a contractor price before you confirm your own quote.</p>'}
    <button id="spec-gen" class="secondary">Generate contractor specs</button>
  </div>

  <div class="card"><h2>Plans &amp; documents</h2>
    <p class="small muted">Site plans, engineering, council stamps - anything worth keeping on this job. PDFs and photos ticked on a spec sheet get stapled into that spec's PDF.</p>
    <div id="jdoc-list">${(job.documents || []).map(d => `
      <div class="item-row">
        <a class="title grow" href="/uploads/${esc(d.file)}" target="_blank">${esc(d.label)}</a>
        <span class="small muted">${fmtD(d.addedAt)}</span>
        <button class="small-btn secondary" data-jdocdel="${esc(d.file)}">x</button>
      </div>`).join('') || '<p class="muted">Nothing uploaded yet.</p>'}</div>
    <input type="file" id="jdoc-file" accept=".pdf,image/*" style="display:none">
    <button id="jdoc-add" class="secondary">+ Upload a plan / document</button>
  </div>

  <div class="card"><h2>Owner only</h2>
    <p class="small muted">Passcode protected - actual costs and profit on this job. Others using this system cannot open it.</p>
    <a class="btn secondary" href="#/job/${job.id}/costs">Job costs &amp; profit</a>
  </div>

  <div class="card"><h2>Customer update</h2>
    <p class="small muted">One tap writes a plain-English text for the customer based on where the job is at.</p>
    <button id="upd-gen" class="secondary">Write update message</button>
    <div id="upd-box" style="display:none">
      <label class="field"><textarea id="upd-text"></textarea></label>
      <div class="row"><button id="upd-copy">Copy to clipboard</button>
      <button id="upd-log" class="secondary">Log as sent</button></div>
    </div>
    ${job.updatesLog.length ? '<h3>Updates sent</h3>' + job.updatesLog.map(u =>
      `<p class="small"><span class="muted">${fmtD(u.date)}:</span> ${esc(u.message)}</p>`).join('') : ''}
  </div>`;

  view().innerHTML = html;

  document.querySelectorAll('.stage-chip').forEach(chip => {
    chip.onclick = async () => {
      const stage = chip.dataset.stage;
      if (stage === job.stage) return;
      try {
        await api('PUT', '/api/jobs/' + id, { stage });
        toast('Moved to "' + STAGE_LABELS[stage] + '". Now update the next action.');
        await viewJob(id);
        const na = $('#na-text'); if (na) { na.focus(); na.select(); }
      } catch (e) { toast(e.message, true); }
    };
  });
  $('#j-approval').onchange = () => api('PUT', '/api/jobs/' + id, { approvalStatus: $('#j-approval').value }).then(() => toast('Saved')).catch(e => toast(e.message, true));
  $('#j-resp').onchange = () => api('PUT', '/api/jobs/' + id, { responsible: $('#j-resp').value }).then(() => toast('Saved')).catch(e => toast(e.message, true));
  $('#na-save').onclick = async () => {
    try {
      await api('PUT', '/api/jobs/' + id, { nextAction: { text: $('#na-text').value, due: $('#na-due').value, who: $('#na-who').value } });
      toast('Next action saved');
    } catch (e) { toast(e.message, true); }
  };
  $('#q-new').onclick = async () => {
    try {
      const q = await api('POST', '/api/quotes', { jobId: id, templateId: $('#q-template').value });
      location.hash = '#/quote/' + q.id;
    } catch (e) { toast(e.message, true); }
  };
  $('#spec-gen').onclick = async () => {
    try {
      const created = await api('POST', '/api/jobs/' + id + '/specs/generate');
      toast(created.length + ' spec sheet(s) ready');
      viewJob(id);
    } catch (e) { toast(e.message, true); }
  };
  $('#jdoc-add').onclick = () => $('#jdoc-file').click();
  $('#jdoc-file').onchange = async () => {
    const file = $('#jdoc-file').files[0];
    if (!file) return;
    const label = prompt('What is this document? (e.g. Site plan, Engineering)', file.name) || file.name;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('label', label);
    const res = await fetch('/api/jobs/' + id + '/documents', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) return toast(data.error || 'Upload failed', true);
    toast('Uploaded');
    viewJob(id);
  };
  document.querySelectorAll('[data-jdocdel]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this document from the job?')) return;
    await api('DELETE', '/api/jobs/' + id + '/documents/' + b.dataset.jdocdel);
    viewJob(id);
  });
  $('#upd-gen').onclick = async () => {
    const r = await api('POST', '/api/jobs/' + id + '/update-draft');
    $('#upd-box').style.display = 'block';
    $('#upd-text').value = r.message;
  };
  $('#upd-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#upd-text').value); toast('Copied - paste into a text or email'); }
    catch (e) { toast('Could not copy - select the text and copy manually', true); }
  };
  $('#upd-log').onclick = async () => {
    await api('POST', '/api/jobs/' + id + '/updates-log', { message: $('#upd-text').value });
    toast('Logged'); viewJob(id);
  };
}

// ---------- Site survey ----------
async function viewSurvey(jobId) {
  const job = await api('GET', '/api/jobs/' + jobId);
  const S = job.survey || await api('GET', '/api/empty-survey');
  const m = S.measurements, cond = S.conditions;
  // Surveys saved before these sections existed get the empty fields.
  m.excavation = m.excavation || { lengthM: '', widthM: '', depthM: '' };
  S.scan = S.scan || { file: null };
  m.slab = m.slab || { lengthM: '', widthM: '', depthM: '' };
  m.retainingWalls = m.retainingWalls || [];
  m.decking = m.decking || { lengthM: '', widthM: '', brand: '' };
  m.decking.placement = m.decking.placement || 'front';
  m.plumbing = m.plumbing || { drainagePitRequired: false, notes: '' };
  m.electrical = m.electrical || { supplyAmps: '', runM: '' };

  const distSuggestions = ['rear boundary', 'side boundary (left)', 'side boundary (right)', 'front boundary', 'house wall', 'switchboard', 'water tap', 'sewer point', 'gate'];
  // In-ground and semi-in-ground jobs: the dig size drives the slab and retaining pre-fill
  const digPrefill = /in-?ground|semi|plunge/i.test(job.installType || '');

  view().innerHTML = `
  <div class="card"><h2>Site survey - ${esc(job.title)}</h2>
    <p class="muted small">${esc(job.siteAddress || '')}</p>
    <div class="row">
      <label class="field grow"><span>Done by</span><input type="text" id="s-by" value="${esc(S.completedBy)}"></label>
      <label class="field grow"><span>Date</span><input type="date" id="s-date" value="${esc(S.date)}"></label>
    </div>
  </div>

  <div class="card"><h2>1. Photos</h2>
    <p class="small muted">Take plenty: spa position, the whole access route gate-to-position, the switchboard, anything in the way. Then tap a photo to draw on it - mark the spa position, pipe runs, access route.</p>
    <input type="file" id="ph-file" accept="image/*" capture="environment" style="display:none">
    <button id="ph-add">+ Add photo</button>
    <div class="photo-grid" id="ph-grid" style="margin-top:10px"></div>
  </div>

  <div class="card"><h2>2. Video walkthrough</h2>
    <p class="small muted">Walk the site and talk: where the spa goes, sizes, how gear gets in, hazards, what the customer asked for. Upload it here and the words become notes automatically.</p>
    <input type="file" id="vid-file" accept="video/*,audio/*" style="display:none">
    <div class="row">
      <button id="vid-add">${S.video.file ? 'Replace video' : '+ Upload video'}</button>
      ${'' /* transcribe appears when a file exists */}
      <button id="vid-transcribe" class="secondary" ${S.video.file ? '' : 'disabled'}>Transcribe video</button>
    </div>
    <p id="vid-status" class="small muted">${S.video.file ? 'Video on file: ' + esc(S.video.file) : 'No video yet.'}</p>
    <div id="vid-player"></div>
    <label class="field"><span>Transcript (edit freely, or type notes here if you skip the video)</span>
      <textarea id="vid-transcript" rows="5">${esc(S.video.transcript)}</textarea></label>
    <button id="vid-structure" class="secondary">Sort transcript into notes below</button>
    <h3>Structured notes (one point per line)</h3>
    ${['position', 'dimensions', 'access', 'hazards', 'requests', 'general'].map(k => `
      <label class="field"><span>${{ position: 'Position - where it goes', dimensions: 'Dimensions mentioned', access: 'Access', hazards: 'Hazards', requests: 'Customer requests', general: 'Everything else' }[k]}</span>
      <textarea id="sn-${k}" rows="2">${esc((S.video.structuredNotes[k] || []).join('\n'))}</textarea></label>`).join('')}
  </div>

  <div class="card"><h2>3. Sketch</h2>
    <p class="small muted">Rough layout with your finger or a stylus: house, fence, spa position, pipe runs, access route. Does not need to be pretty.</p>
    ${S.sketch.file ? `<p class="small">Saved sketch:</p><img src="/uploads/${esc(S.sketch.file)}" style="max-width:100%;border:1px solid var(--line);border-radius:8px">` : ''}
    <div class="sketch-wrap" style="margin-top:8px"><canvas id="sketch-canvas" width="1000" height="600"></canvas></div>
    <div class="canvas-tools">
      <button class="small-btn" data-pen="#111">Black pen</button>
      <button class="small-btn danger" data-pen="#c22">Red pen</button>
      <button class="small-btn secondary" id="sk-undo">Undo</button>
      <button class="small-btn secondary" id="sk-clear">Clear</button>
      <button class="small-btn" id="sk-save">Save sketch</button>
    </div>
  </div>

  <div class="card"><h2>3D scan of the yard (optional)</h2>
    <p class="small muted">Scan the yard with Polycam or Scaniverse (5-10 careful minutes), export as <b>GLTF</b>, and upload the file here - the .zip Polycam gives you works as-is. The 3D view can then show the spa sitting in the customer's actual yard. Worth it on the big jobs; skip it on simple ones.</p>
    <div class="row">
      <a class="btn secondary" href="polycam://">Open Polycam to scan</a>
    </div>
    <input type="file" id="scan-file" accept=".glb,.gltf,.zip" style="display:none">
    <div class="row">
      <button id="scan-add" class="secondary">${S.scan && S.scan.file ? 'Replace scan' : '+ Upload scan (.glb or Polycam .zip)'}</button>
      <span id="scan-status" class="small muted">${S.scan && S.scan.file ? 'Scan on file: ' + esc(S.scan.file) : 'No scan yet.'}</span>
    </div>
  </div>

  <div class="card"><h2>4. Measurements</h2>
    <h3>Spa / pool size</h3>
    <div id="spa-model-box"></div>
    <div class="row" style="margin-bottom:6px">
      <button class="small-btn secondary" id="spa-pick">Pick the spa from the catalogue</button>
    </div>
    <div class="row">
      <label class="field grow"><span>Length (m)</span><input type="number" step="0.01" id="m-len" value="${esc(m.spa.lengthM)}"></label>
      <label class="field grow"><span>Width (m)</span><input type="number" step="0.01" id="m-wid" value="${esc(m.spa.widthM)}"></label>
      <label class="field grow"><span>Depth/height (m)</span><input type="number" step="0.01" id="m-dep" value="${esc(m.spa.depthM)}"></label>
      <label class="field grow"><span>Dry weight (kg)</span><input type="number" id="m-kg" value="${esc(m.spa.weightKg)}"></label>
    </div>
    <h3>Excavation size (in-ground digs)</h3>
    <p class="small muted">The hole, not the spa: allow for the base and working room. The system works out the spoil and truck loads for you.</p>
    <div class="row">
      <label class="field grow"><span>Dig length (m)</span><input type="number" step="0.01" id="ex-len" value="${esc(m.excavation.lengthM)}"></label>
      <label class="field grow"><span>Dig width (m)</span><input type="number" step="0.01" id="ex-wid" value="${esc(m.excavation.widthM)}"></label>
      <label class="field grow"><span>Dig depth (m)</span><input type="number" step="0.01" id="ex-dep" value="${esc(m.excavation.depthM)}"></label>
    </div>
    <p id="ex-calc" class="small" style="font-weight:600"></p>

    <h3>Concrete slab</h3>
    ${digPrefill ? '<p class="small muted">In-ground job: entering the dig size above fills the slab size and a retaining wall row for you - change anything that is different on site.</p>' : ''}
    <div class="row">
      <label class="field grow"><span>Slab length (m)</span><input type="number" step="0.01" id="sl-len" value="${esc(m.slab.lengthM)}"></label>
      <label class="field grow"><span>Slab width (m)</span><input type="number" step="0.01" id="sl-wid" value="${esc(m.slab.widthM)}"></label>
      <label class="field grow"><span>Slab thickness (mm)</span><input type="number" step="5" id="sl-dep" value="${m.slab.depthM ? Math.round(parseFloat(m.slab.depthM) * 1000) : ''}" placeholder="e.g. 125"></label>
    </div>
    <p id="sl-calc" class="small" style="font-weight:600"></p>

    <h3>Retaining walls</h3>
    <p class="small muted">One row per wall. Pick a type or type your own.</p>
    <div id="wall-rows"></div>
    <button class="small-btn secondary" id="wall-add">+ Add retaining wall</button>
    <p id="wall-calc" class="small" style="font-weight:600"></p>
    <datalist id="wall-types">
      <option value="Timber sleepers"><option value="Concrete sleepers">
      <option value="Dincel"><option value="Besser block">
    </datalist>

    <h3>Decking</h3>
    <div class="row">
      <label class="field grow"><span>Deck length (m)</span><input type="number" step="0.01" id="dk-len" value="${esc(m.decking.lengthM)}"></label>
      <label class="field grow"><span>Deck width (m)</span><input type="number" step="0.01" id="dk-wid" value="${esc(m.decking.widthM)}"></label>
      <label class="field grow"><span>Where does it go?</span>
        <select id="dk-place">${[['front', 'In front of the spa'], ['around', 'All around the spa'], ['left', 'Left of the spa'], ['right', 'Right of the spa'], ['behind', 'Behind the spa']].map(([v, l]) =>
          `<option value="${v}" ${(m.decking.placement || 'front') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field grow"><span>Decking brand / board</span><input type="text" list="deck-brands" id="dk-brand" value="${esc(m.decking.brand)}" placeholder="pick a board or type your own"></label>
    </div>
    <datalist id="deck-brands"></datalist>
    <p id="dk-calc" class="small" style="font-weight:600"></p>

    <h3>Plumbing</h3>
    <div class="check-row"><input type="checkbox" id="pl-pit" ${m.plumbing.drainagePitRequired ? 'checked' : ''}><label for="pl-pit">External drainage pit required</label></div>
    <label class="field"><span>Plumbing notes (where the pit ties in, existing drainage...)</span><input type="text" id="pl-notes" value="${esc(m.plumbing.notes)}"></label>

    <h3>Electrical</h3>
    <p class="small muted">Tick every supply this job needs (a spa circuit plus a 10 A auxiliary is common).</p>
    <div class="row">
      ${['10 A', '15 A', '32 A'].map((a, i) => `
      <div class="check-row"><input type="checkbox" id="el-a${i}" ${(m.electrical.supplyAmps || '').includes(a) ? 'checked' : ''}><label for="el-a${i}">${a}</label></div>`).join('')}
      <label class="field grow"><span>Cable run length (m)</span><input type="number" step="0.1" id="el-run" value="${esc(m.electrical.runM)}" placeholder="switchboard to spa"></label>
    </div>
    <p class="small muted">The quote's electrical run uses this length. If left blank it falls back to the "distance to switchboard" below.</p>

    <h3>Distances from spa position</h3>
    <p class="small muted">Measure to boundaries, the house, the switchboard, and the nearest water/sewer point. The quote uses these.</p>
    <div id="dist-rows"></div>
    <button class="small-btn secondary" id="dist-add">+ Add distance</button>
    <datalist id="dist-suggestions">${distSuggestions.map(d => `<option value="${d}">`).join('')}</datalist>
    <h3>Access</h3>
    <div class="row">
      <label class="field grow"><span>Narrowest access point (m)</span><input type="number" step="0.01" id="m-access" value="${esc(m.accessWidthM)}"></label>
      <label class="field grow"><span>Steps / level changes on the route</span><input type="text" id="m-steps" value="${esc(m.stepLevelChanges)}" placeholder="e.g. 2 steps down at gate, then flat"></label>
    </div>
  </div>

  <div class="card"><h2>5. Site conditions</h2>
    <div class="row">
      <label class="field grow"><span>Ground type</span>
        <select id="c-ground">${['', 'grass over soil', 'clay', 'sand', 'rock', 'existing concrete/pavers', 'fill/unknown'].map(g =>
          `<option ${cond.groundType === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
      <label class="field grow"><span>Slope</span>
        <select id="c-slope">${['', 'flat', 'slight fall', 'moderate slope', 'steep'].map(g =>
          `<option ${cond.slope === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
    </div>
    <label class="field"><span>Obstacles (trees, sheds, AC units...)</span><input type="text" id="c-obstacles" value="${esc(cond.obstacles)}"></label>
    <label class="field"><span>Visible utilities (meters, pipes, pits, overhead lines)</span><input type="text" id="c-utilities" value="${esc(cond.visibleUtilities)}"></label>
    <div class="check-row"><input type="checkbox" id="c-crane" ${cond.craneNeeded ? 'checked' : ''}><label for="c-crane">Crane or machinery needed to get it in</label></div>
    <label class="field"><span>Machinery / crane notes (where it sets up, overhead wires, permits)</span><input type="text" id="c-machinery" value="${esc(cond.machineryNotes)}"></label>
  </div>

  <div class="card"><h2>6. What the customer wants</h2>
    <label class="field"><span>Wishlist / notes from the conversation</span><textarea id="s-wishlist">${esc(S.wishlist)}</textarea></label>
    <label class="field"><span>Budget indication</span><input type="text" id="s-budget" value="${esc(S.budgetIndication)}" placeholder="e.g. around $25k all up"></label>
  </div>

  <div class="card">
    <div class="row">
      <button id="s-save">Save survey</button>
      <button id="s-done" class="secondary">Save + mark survey done</button>
      <a class="btn secondary" href="#/job/${job.id}">Back to job</a>
    </div>
    <p class="small muted">Saving is safe to do as often as you like - do it before you leave the site.</p>
  </div>`;

  // ---- photos ----
  function renderPhotos() {
    $('#ph-grid').innerHTML = S.photos.map((p, i) => `
      <div class="photo-card">
        <img src="${p.dataUrl ? esc(p.dataUrl) : '/uploads/' + esc(p.annotatedFile || p.file)}" data-annotate="${i}" alt="site photo">
        <div class="pc-body">
          <input type="text" data-caption="${i}" value="${esc(p.caption)}" placeholder="What is this photo of?">
          <p class="small muted" style="margin:6px 0 0">${p.local ? 'On this device - syncs when back in range' : (p.annotatedFile ? 'Marked up - tap to redraw' : 'Tap photo to draw on it')}</p>
        </div>
      </div>`).join('');
    document.querySelectorAll('[data-caption]').forEach(inp => {
      inp.oninput = () => { S.photos[+inp.dataset.caption].caption = inp.value; };
    });
    document.querySelectorAll('[data-annotate]').forEach(img => {
      img.onclick = () => {
        const p = S.photos[+img.dataset.annotate];
        if (p.local) return toast('You can draw on this one once it has synced to the office');
        openAnnotator(p);
      };
    });
  }
  // photos taken offline earlier are waiting in the queue - show them
  queueAll().then(items => {
    let added = false;
    for (const { value } of items) {
      if (value.kind === 'photo' && value.jobId === jobId && !S.photos.some(p => p.id === value.localId)) {
        S.photos.push({ id: value.localId, local: true, dataUrl: value.dataUrl, caption: value.caption || '' });
        added = true;
      }
    }
    if (added) renderPhotos();
  }).catch(() => {});
  renderPhotos();

  $('#ph-add').onclick = () => $('#ph-file').click();
  $('#ph-file').onchange = async () => {
    const file = $('#ph-file').files[0];
    if (!file) return;
    const fd = new FormData(); fd.append('photo', file);
    toast('Saving photo...');
    try {
      const res = await fetch('/api/jobs/' + jobId + '/photos', { method: 'POST', body: fd });
      const photo = await res.json();
      if (!res.ok) return toast(photo.error || 'Upload failed', true);
      S.photos.push(photo);
    } catch (e) {
      // no connection: keep it on the phone, sync later
      const dataUrl = await new Promise(r => {
        const fr = new FileReader();
        fr.onload = () => r(fr.result);
        fr.readAsDataURL(file);
      });
      const localId = 'local_' + Date.now();
      await queuePut('photo_' + jobId + '_' + localId, { kind: 'photo', jobId, localId, dataUrl, caption: '' });
      S.photos.push({ id: localId, local: true, dataUrl, caption: '' });
      toast('No signal - photo saved on this device, will sync when back in range');
    }
    renderPhotos();
    $('#ph-file').value = '';
  };

  function openAnnotator(photo) {
    const rootEl = $('#modal-root');
    rootEl.innerHTML = `<div class="overlay">
      <canvas class="draw" id="anno-canvas"></canvas>
      <div class="canvas-tools">
        <button class="small-btn danger" data-apen="#e03131">Red pen</button>
        <button class="small-btn" data-apen="#ffd43b" style="background:#b08900">Yellow pen</button>
        <button class="small-btn secondary" id="an-undo">Undo</button>
        <button class="small-btn" id="an-save">Save markup</button>
        <button class="small-btn secondary" id="an-close">Close</button>
      </div></div>`;
    const canvas = $('#anno-canvas');
    const img = new Image();
    img.onload = () => {
      const maxW = 1600;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      canvas.style.maxHeight = '70vh';
      const draw = makeDrawing(canvas, () => {
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }, '#e03131', 6);
      rootEl.querySelectorAll('[data-apen]').forEach(b => b.onclick = () => draw.setPen(b.dataset.apen));
      $('#an-undo').onclick = draw.undo;
      $('#an-close').onclick = () => { rootEl.innerHTML = ''; };
      $('#an-save').onclick = async () => {
        try {
          const updated = await api('POST', `/api/jobs/${jobId}/photos/${photo.id}/annotate`, { dataUrl: canvas.toDataURL('image/png') });
          photo.annotatedFile = updated.annotatedFile;
          rootEl.innerHTML = '';
          renderPhotos();
          toast('Markup saved');
        } catch (e) { toast(e.message, true); }
      };
    };
    img.src = '/uploads/' + (photo.file);
  }

  // ---- 3D scan ----
  $('#scan-add').onclick = () => $('#scan-file').click();
  $('#scan-file').onchange = async () => {
    const file = $('#scan-file').files[0];
    if (!file) return;
    const fd = new FormData(); fd.append('scan', file);
    $('#scan-status').textContent = 'Uploading scan (' + Math.round(file.size / 1048576) + ' MB)... keep this page open.';
    try {
      const res = await fetch('/api/jobs/' + jobId + '/scan', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) { $('#scan-status').textContent = 'Upload failed.'; return toast(data.error || 'Upload failed', true); }
      S.scan = data;
      $('#scan-status').textContent = 'Scan on file: ' + data.file + ' - open the 3D view to see the spa in it.';
      toast('Scan uploaded');
    } catch (e) {
      $('#scan-status').textContent = 'No signal - the scan stays in the scanning app. Upload it here when you are back in range.';
      toast('No signal for the scan - upload it when back in range', true);
    }
  };

  // ---- video ----
  function renderVideoPlayer() {
    const box = $('#vid-player');
    if (!S.video.file) { box.innerHTML = ''; return; }
    const src = '/uploads/' + encodeURIComponent(S.video.file);
    const isAudioOnly = /\.(mp3|m4a|aac|wav|aiff|aif)$/i.test(S.video.file);
    box.innerHTML = isAudioOnly
      ? `<audio controls src="${src}" style="width:100%;margin:8px 0"></audio>`
      : `<video controls playsinline src="${src}" style="width:100%;max-height:360px;border-radius:10px;margin:8px 0;background:#000"></video>`;
  }
  renderVideoPlayer();
  let transcribeEnabled = true;
  async function runTranscribe() {
    if (!transcribeEnabled) return;
    $('#vid-transcribe').disabled = true;
    $('#vid-status').textContent = 'Transcribing... first time can take several minutes (downloads the speech model once). Keep this page open.';
    try {
      const v = await api('POST', '/api/jobs/' + jobId + '/transcribe');
      S.video.transcript = v.transcript;
      S.video.structuredNotes = v.structuredNotes;
      $('#vid-transcript').value = v.transcript;
      for (const k of ['position', 'dimensions', 'access', 'hazards', 'requests', 'general']) {
        $('#sn-' + k).value = (v.structuredNotes[k] || []).join('\n');
      }
      $('#vid-status').textContent = 'Transcribed. Check the notes below and fix anything it misheard.';
    } catch (e) {
      $('#vid-status').textContent = e.message;
      toast(e.message, true);
    }
    $('#vid-transcribe').disabled = false;
  }
  $('#vid-add').onclick = () => $('#vid-file').click();
  $('#vid-file').onchange = async () => {
    const file = $('#vid-file').files[0];
    if (!file) return;
    const fd = new FormData(); fd.append('video', file);
    $('#vid-status').textContent = 'Uploading video... keep this page open.';
    try {
      const res = await fetch('/api/jobs/' + jobId + '/video', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) { $('#vid-status').textContent = 'Upload failed.'; return toast(data.error || 'Upload failed', true); }
      S.video.file = data.file;
      $('#vid-transcribe').disabled = false;
      renderVideoPlayer();
      toast('Video uploaded');
      if (transcribeEnabled) {
        runTranscribe(); // starts automatically - no need to tap the button
      } else {
        $('#vid-status').textContent = 'Video on file: ' + data.file;
      }
    } catch (e) {
      $('#vid-status').textContent = 'No signal - the video stays in your camera roll. Upload it here when you are back in range.';
      toast('No signal for the video - it is safe in your camera roll, upload later', true);
    }
  };
  $('#vid-transcribe').onclick = runTranscribe;
  // hosted version has no transcription horsepower - grey the button honestly
  api('GET', '/api/meta').then(mt => {
    if (mt.transcribe === false) {
      transcribeEnabled = false;
      const b = $('#vid-transcribe');
      b.disabled = true;
      b.textContent = 'Transcribe (not available on hosted version)';
    }
  }).catch(() => {});

  $('#vid-structure').onclick = async () => {
    const notes = await api('POST', '/api/structure-notes', { text: $('#vid-transcript').value });
    for (const k of ['position', 'dimensions', 'access', 'hazards', 'requests', 'general']) {
      $('#sn-' + k).value = (notes[k] || []).join('\n');
    }
    toast('Sorted - check each box');
  };

  // ---- sketch ----
  const sk = makeDrawing($('#sketch-canvas'), (ctx, canvas) => {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, '#111', 4);
  document.querySelectorAll('[data-pen]').forEach(b => b.onclick = () => sk.setPen(b.dataset.pen));
  $('#sk-undo').onclick = sk.undo;
  $('#sk-clear').onclick = sk.clear;
  $('#sk-save').onclick = async () => {
    const dataUrl = $('#sketch-canvas').toDataURL('image/png');
    try {
      const r = await api('POST', '/api/jobs/' + jobId + '/sketch', { dataUrl });
      S.sketch = r;
      toast('Sketch saved');
    } catch (e) {
      if (isNetworkError(e)) {
        await queuePut('sketch_' + jobId, { kind: 'sketch', jobId, dataUrl });
        toast('No signal - sketch saved on this device, will sync when back in range');
      } else toast(e.message, true);
    }
  };

  // ---- spa model from the catalogue ----
  function renderSpaModel() {
    const sm = S.spaModel;
    $('#spa-model-box').innerHTML = sm ? `
      <div class="row" style="align-items:center;background:var(--green-bg);border-radius:10px;padding:8px;margin-bottom:6px">
        ${sm.image ? `<img src="/catalogue-images/${esc(sm.image)}" style="width:86px;height:64px;object-fit:cover;border-radius:8px">` : ''}
        <span class="grow"><b>${esc(sm.name)}</b><br><span class="small muted">${esc(sm.brand)} - ${esc(sm.retailer)}. Sizes filled from the catalogue - measure and adjust if the site says otherwise.</span></span>
        <button class="small-btn secondary" id="spa-clear">Remove</button>
      </div>` : '';
    if (sm) $('#spa-clear').onclick = () => { S.spaModel = null; renderSpaModel(); };
  }
  renderSpaModel();
  $('#spa-pick').onclick = () => openCataloguePicker(model => {
    S.spaModel = { id: model.id, name: model.name, brand: model.brand, retailer: model.retailer, image: model.image };
    if (model.lengthM) { m.spa.lengthM = String(model.lengthM); $('#m-len').value = model.lengthM; }
    if (model.widthM) { m.spa.widthM = String(model.widthM); $('#m-wid').value = model.widthM; }
    if (model.heightM) { m.spa.depthM = String(model.heightM); $('#m-dep').value = model.heightM; }
    renderSpaModel();
    toast('Spa set: ' + model.name);
  });

  // ---- decking board suggestions (Innowood / Millboard library) ----
  api('GET', '/api/decking').then(lib => {
    $('#deck-brands').innerHTML = lib.map(b =>
      `<option value="${esc(b.brand + ' ' + b.name)}">`).join('');
  }).catch(() => {});

  // ---- excavation calc ----
  const BOGIE_TRUCK_M3 = 6.5; // one bogie truck load = 6.5 m3 (~12 t in soil)
  function updateExcCalc() {
    const l = parseFloat($('#ex-len').value), w = parseFloat($('#ex-wid').value), d = parseFloat($('#ex-dep').value);
    const el = $('#ex-calc');
    if (!l || !w || !d) {
      el.textContent = 'Enter length, width and depth to size the dig.';
      el.className = 'small muted';
      return;
    }
    const vol = l * w * d;
    const loads = vol / BOGIE_TRUCK_M3;
    el.textContent = 'Spoil: ' + (Math.round(vol * 10) / 10) + ' m3 (~' + (Math.round(loads * 12 * 10) / 10) +
      ' t) = ' + (Math.round(loads * 100) / 100) + ' bogie truck loads. Allow ' + Math.ceil(loads) +
      ' load' + (Math.ceil(loads) === 1 ? '' : 's') + ' (' + BOGIE_TRUCK_M3 + ' m3 / ~12 t each).';
    el.className = 'small';
    maybePrefillFromDig(l, w, d);
  }
  // In-ground/semi-in-ground: dig size fills the slab (same footprint) and one
  // retaining wall row (dig perimeter x dig depth). Never overwrites anything
  // already entered, and only offers the wall row once.
  let wallsPrefilled = (m.retainingWalls || []).length > 0;
  function maybePrefillFromDig(l, w, d) {
    if (!digPrefill || !l || !w) return;
    if (!$('#sl-len').value && !$('#sl-wid').value) {
      $('#sl-len').value = l; $('#sl-wid').value = w;
      m.slab.lengthM = String(l); m.slab.widthM = String(w);
      updateSlabCalc();
    }
    if (d && !wallsPrefilled) {
      wallsPrefilled = true;
      m.retainingWalls.push({ type: '', lengthM: String(Math.round(2 * (l + w) * 10) / 10), heightM: String(d), thicknessM: '' });
      renderWalls();
      toast('Slab and retaining wall pre-filled from the dig - adjust to suit');
    }
  }
  ['ex-len', 'ex-wid', 'ex-dep'].forEach(id => { $('#' + id).oninput = updateExcCalc; });
  updateExcCalc();

  // ---- slab calc (thickness entered in mm) ----
  function updateSlabCalc() {
    const l = parseFloat($('#sl-len').value), w = parseFloat($('#sl-wid').value);
    const d = (parseFloat($('#sl-dep').value) || 0) / 1000;
    const el = $('#sl-calc');
    if (!l || !w) { el.textContent = 'Enter length and width to size the slab.'; el.className = 'small muted'; return; }
    let text = 'Slab: ' + (Math.round(l * w * 10) / 10) + ' m2';
    if (d) text += ' - ' + (Math.round(l * w * d * 100) / 100) + ' m3 of concrete needed';
    el.textContent = text + '.';
    el.className = 'small';
  }
  ['sl-len', 'sl-wid', 'sl-dep'].forEach(id => { $('#' + id).oninput = updateSlabCalc; });
  updateSlabCalc();

  // ---- retaining walls ----
  function updateWallCalc() {
    const walls = m.retainingWalls.filter(w => parseFloat(w.lengthM) && parseFloat(w.heightM));
    const el = $('#wall-calc');
    if (!walls.length) { el.textContent = ''; return; }
    const total = walls.reduce((t, w) => t + parseFloat(w.lengthM) * parseFloat(w.heightM), 0);
    el.textContent = 'Total wall face: ' + (Math.round(total * 10) / 10) + ' m2 across ' + walls.length + ' wall' + (walls.length === 1 ? '' : 's') + '.';
    el.className = 'small';
  }
  function renderWalls() {
    $('#wall-rows').innerHTML = m.retainingWalls.map((w, i) => `
      <div class="row" style="margin:6px 0">
        <input type="text" list="wall-types" class="grow" data-wtype="${i}" value="${esc(w.type)}" placeholder="wall type">
        <input type="number" step="0.01" style="width:95px" data-wlen="${i}" value="${esc(w.lengthM)}" placeholder="length m">
        <input type="number" step="0.01" style="width:95px" data-whgt="${i}" value="${esc(w.heightM)}" placeholder="height m">
        <input type="number" step="0.005" style="width:95px" data-wthk="${i}" value="${esc(w.thicknessM)}" placeholder="thick m">
        <button class="small-btn secondary" data-wdel="${i}">x</button>
      </div>`).join('');
    const wbind = (attr, key) => document.querySelectorAll('[' + attr + ']').forEach(inp =>
      inp.oninput = () => { m.retainingWalls[+inp.getAttribute(attr)][key] = inp.value; updateWallCalc(); });
    wbind('data-wtype', 'type'); wbind('data-wlen', 'lengthM'); wbind('data-whgt', 'heightM'); wbind('data-wthk', 'thicknessM');
    document.querySelectorAll('[data-wdel]').forEach(b => b.onclick = () => { m.retainingWalls.splice(+b.dataset.wdel, 1); renderWalls(); });
    updateWallCalc();
  }
  renderWalls();
  $('#wall-add').onclick = () => { m.retainingWalls.push({ type: '', lengthM: '', heightM: '', thicknessM: '' }); renderWalls(); };

  // ---- decking calc ----
  function updateDeckCalc() {
    const l = parseFloat($('#dk-len').value), w = parseFloat($('#dk-wid').value);
    const el = $('#dk-calc');
    if (!l || !w) { el.textContent = ''; return; }
    el.textContent = 'Decking: ' + (Math.round(l * w * 10) / 10) + ' m2 total.';
    el.className = 'small';
  }
  ['dk-len', 'dk-wid'].forEach(id => { $('#' + id).oninput = updateDeckCalc; });
  updateDeckCalc();

  // ---- distances ----
  function renderDists() {
    $('#dist-rows').innerHTML = m.distances.map((d, i) => `
      <div class="row" style="margin:6px 0">
        <input type="text" list="dist-suggestions" class="grow" data-dlabel="${i}" value="${esc(d.label)}" placeholder="to what? e.g. rear boundary">
        <input type="number" step="0.01" style="width:110px" data-dm="${i}" value="${esc(d.metres)}" placeholder="metres">
        <button class="small-btn secondary" data-ddel="${i}">x</button>
      </div>`).join('');
    document.querySelectorAll('[data-dlabel]').forEach(inp => inp.oninput = () => { m.distances[+inp.dataset.dlabel].label = inp.value; });
    document.querySelectorAll('[data-dm]').forEach(inp => inp.oninput = () => { m.distances[+inp.dataset.dm].metres = inp.value; });
    document.querySelectorAll('[data-ddel]').forEach(b => b.onclick = () => { m.distances.splice(+b.dataset.ddel, 1); renderDists(); });
  }
  renderDists();
  $('#dist-add').onclick = () => { m.distances.push({ label: '', metres: '' }); renderDists(); };

  // ---- save ----
  function collect() {
    S.completedBy = $('#s-by').value; S.date = $('#s-date').value;
    S.video.transcript = $('#vid-transcript').value;
    for (const k of ['position', 'dimensions', 'access', 'hazards', 'requests', 'general']) {
      S.video.structuredNotes[k] = $('#sn-' + k).value.split('\n').map(x => x.trim()).filter(Boolean);
    }
    m.spa.lengthM = $('#m-len').value; m.spa.widthM = $('#m-wid').value;
    m.spa.depthM = $('#m-dep').value; m.spa.weightKg = $('#m-kg').value;
    m.excavation.lengthM = $('#ex-len').value; m.excavation.widthM = $('#ex-wid').value;
    m.excavation.depthM = $('#ex-dep').value;
    m.slab.lengthM = $('#sl-len').value; m.slab.widthM = $('#sl-wid').value;
    m.slab.depthM = $('#sl-dep').value ? String(parseFloat($('#sl-dep').value) / 1000) : '';
    m.decking.lengthM = $('#dk-len').value; m.decking.widthM = $('#dk-wid').value;
    m.decking.placement = $('#dk-place').value; m.decking.brand = $('#dk-brand').value;
    m.plumbing.drainagePitRequired = $('#pl-pit').checked; m.plumbing.notes = $('#pl-notes').value;
    m.electrical.supplyAmps = ['10 A', '15 A', '32 A'].filter((a, i) => $('#el-a' + i).checked).join(' + ');
    m.electrical.runM = $('#el-run').value;
    m.retainingWalls = m.retainingWalls.filter(w => (w.type || '').trim() || parseFloat(w.lengthM));
    m.accessWidthM = $('#m-access').value; m.stepLevelChanges = $('#m-steps').value;
    cond.groundType = $('#c-ground').value; cond.slope = $('#c-slope').value;
    cond.obstacles = $('#c-obstacles').value; cond.visibleUtilities = $('#c-utilities').value;
    cond.craneNeeded = $('#c-crane').checked; cond.machineryNotes = $('#c-machinery').value;
    S.wishlist = $('#s-wishlist').value; S.budgetIndication = $('#s-budget').value;
  }
  async function save(markDone) {
    collect();
    // photos still waiting on this device are synced separately - keep their
    // latest captions in the queue and leave them out of the server copy
    for (const p of S.photos.filter(x => x.local)) {
      await queuePut('photo_' + jobId + '_' + p.id, { kind: 'photo', jobId, localId: p.id, dataUrl: p.dataUrl, caption: p.caption || '' }).catch(() => {});
    }
    const clean = JSON.parse(JSON.stringify(S));
    clean.photos = clean.photos.filter(p => !p.local);
    const body = { survey: clean };
    if (markDone) {
      body.stage = 'survey_done';
      body.nextAction = { text: 'Put the quote together', due: '', who: job.responsible };
    }
    try {
      await api('PUT', '/api/jobs/' + jobId, body);
      toast(markDone ? 'Survey done - next: the quote' : 'Survey saved');
      syncQueue();
      if (markDone) location.hash = '#/job/' + jobId;
    } catch (e) {
      if (isNetworkError(e)) {
        await queuePut('survey_' + jobId, { kind: 'survey', jobId, body });
        toast('No signal - survey saved on this device, will sync when back in range');
        if (markDone) location.hash = '#/job/' + jobId;
      } else throw e;
    }
  }
  $('#s-save').onclick = () => save(false).catch(e => toast(e.message, true));
  $('#s-done').onclick = () => save(true).catch(e => toast(e.message, true));
}

// ---------- Owner-only job costs (passcode protected) ----------
function privToken() { return sessionStorage.getItem('privateToken') || ''; }

async function privApi(method, url, body) {
  const opts = { method, headers: { 'x-private-token': privToken() } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) sessionStorage.removeItem('privateToken');
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}

async function viewCosts(jobId) {
  const job = await api('GET', '/api/jobs/' + jobId);
  const status = await privApi('GET', '/api/private/status').catch(() => ({ hasPasscode: false, unlocked: false }));

  if (!status.hasPasscode) return renderGate('setup');
  if (!status.unlocked) return renderGate('unlock');
  return renderCosts();

  function renderGate(mode) {
    view().innerHTML = `<div class="card" style="max-width:420px;margin:40px auto">
      <h2>${mode === 'setup' ? 'Set your owner passcode' : 'Owner area - locked'}</h2>
      <p class="small muted">${mode === 'setup'
        ? 'This protects your costs and profit numbers. Pick something only you know - at least 4 characters. There is no reset, so do not forget it.'
        : 'Enter the passcode to see costs and profit for this job.'}</p>
      <label class="field"><span>Passcode</span><input type="password" id="pc-1" autocomplete="off"></label>
      ${mode === 'setup' ? '<label class="field"><span>Type it again</span><input type="password" id="pc-2" autocomplete="off"></label>' : ''}
      <div class="row">
        <button id="pc-go">${mode === 'setup' ? 'Set passcode and open' : 'Unlock'}</button>
        <a class="btn secondary" href="#/job/${jobId}">Back to job</a>
      </div>
      <p id="pc-msg" class="small" style="color:var(--red)"></p>
    </div>`;
    const go = async () => {
      try {
        if (mode === 'setup') {
          if ($('#pc-1').value !== $('#pc-2').value) { $('#pc-msg').textContent = 'They do not match - try again.'; return; }
          const r = await privApi('POST', '/api/private/setup', { passcode: $('#pc-1').value });
          sessionStorage.setItem('privateToken', r.token);
        } else {
          const r = await privApi('POST', '/api/private/unlock', { passcode: $('#pc-1').value });
          sessionStorage.setItem('privateToken', r.token);
        }
        viewCosts(jobId);
      } catch (e) { $('#pc-msg').textContent = e.message; }
    };
    $('#pc-go').onclick = go;
    $('#pc-1').onkeydown = e => { if (e.key === 'Enter') go(); };
    $('#pc-1').focus();
  }

  async function renderCosts() {
    let C;
    try { C = await privApi('GET', '/api/private/costs/' + jobId); }
    catch (e) { return renderGate('unlock'); }

    const money2 = n => '$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    function totals() {
      const costItems = C.items.reduce((t, i) => t + (parseFloat(i.cost) || 0), 0);
      const costExtras = C.extras.reduce((t, x) => t + (parseFloat(x.cost) || 0), 0);
      const costs = costItems + costExtras;
      const revenue = C.quote ? C.quote.totals.exGst : 0;
      return { costs, revenue, profit: revenue - costs, pct: revenue ? (revenue - costs) / revenue * 100 : 0 };
    }

    function render() {
      const t = totals();
      view().innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <h2 style="margin:0">Job costs &amp; profit - ${esc(job.title)}</h2>
          <span class="badge amber">Owner only</span>
        </div>
        ${C.quote ? `<p class="small muted">Sell prices from the ${C.quote.status} quote. Type in what each item actually costs you as the job runs.</p>`
          : '<p class="small muted">No quote on this job yet - you can still record costs under Extras below.</p>'}
        <div class="row">
          <a class="btn secondary" href="#/job/${jobId}">Back to job</a>
          <button id="c-lock" class="secondary">Lock</button>
          <button id="c-changepc" class="secondary small-btn">Change passcode</button>
        </div>
      </div>

      <div class="card"><h2>Quoted items</h2>
        <table class="li-table"><thead><tr><th>Item</th><th>Sell (ex GST)</th><th>Actual cost</th><th>Notes</th></tr></thead><tbody>
        ${C.items.map((i, idx) => `<tr ${i.inQuote === false ? 'style="opacity:.55"' : ''}>
          <td style="min-width:200px">${esc(i.description)}${i.inQuote === false ? ' <span class="small muted">(no longer in quote)</span>' : ''}<br><span class="small muted">${esc(TRADE_LABELS[i.trade] || i.trade || '')}</span></td>
          <td style="white-space:nowrap">${money2(i.sellEx)}</td>
          <td><input class="num" type="number" step="0.01" data-cost="${idx}" value="${esc(i.cost)}" placeholder="0.00"></td>
          <td><input type="text" data-cnote="${idx}" value="${esc(i.notes)}" placeholder="supplier, invoice no..."></td>
        </tr>`).join('')}
        </tbody></table>
      </div>

      <div class="card"><h2>Extra costs (not in the quote)</h2>
        <p class="small muted">The stuff that comes up: extra tip run, hire gear, a second visit.</p>
        <div id="extra-rows">
        ${C.extras.map((x, idx) => `<div class="row" style="margin:6px 0">
          <input type="text" class="grow" data-xdesc="${idx}" value="${esc(x.description)}" placeholder="what was it">
          <input type="number" step="0.01" style="width:110px" data-xcost="${idx}" value="${esc(x.cost)}" placeholder="cost">
          <button class="small-btn secondary" data-xdel="${idx}">x</button>
        </div>`).join('')}
        </div>
        <button class="small-btn secondary" id="extra-add">+ Add extra cost</button>
      </div>

      <div class="card"><h2>The numbers</h2>
        <div class="totals" style="text-align:left">
          ${C.quote ? `<div>Revenue (quote total ex GST, incl margin): <b>${money2(t.revenue)}</b></div>` : '<div class="muted">No quote yet - revenue unknown.</div>'}
          <div>Actual costs so far: <b>${money2(t.costs)}</b></div>
          <div class="grand" style="color:${t.profit >= 0 ? 'var(--green)' : 'var(--red)'}">
            Profit: ${money2(t.profit)}${C.quote ? ' (' + (Math.round(t.pct * 10) / 10) + '% of revenue)' : ''}
          </div>
          <p class="small muted">GST is left out on both sides so this is a like-for-like comparison.</p>
        </div>
        <button id="c-save">Save costs</button>
      </div>`;

      document.querySelectorAll('[data-cost]').forEach(el => el.onchange = () => { C.items[+el.dataset.cost].cost = el.value; render(); });
      document.querySelectorAll('[data-cnote]').forEach(el => el.oninput = () => { C.items[+el.dataset.cnote].notes = el.value; });
      document.querySelectorAll('[data-xdesc]').forEach(el => el.oninput = () => { C.extras[+el.dataset.xdesc].description = el.value; });
      document.querySelectorAll('[data-xcost]').forEach(el => el.onchange = () => { C.extras[+el.dataset.xcost].cost = el.value; render(); });
      document.querySelectorAll('[data-xdel]').forEach(b => b.onclick = () => { C.extras.splice(+b.dataset.xdel, 1); render(); });
      $('#extra-add').onclick = () => { C.extras.push({ description: '', cost: '' }); render(); };
      $('#c-save').onclick = async () => {
        try {
          await privApi('PUT', '/api/private/costs/' + jobId, { items: C.items, extras: C.extras });
          toast('Costs saved');
        } catch (e) { toast(e.message, true); if (e.status === 401) renderGate('unlock'); }
      };
      $('#c-lock').onclick = () => { sessionStorage.removeItem('privateToken'); renderGate('unlock'); };
      $('#c-changepc').onclick = async () => {
        const cur = prompt('Current passcode:');
        if (cur == null) return;
        const nw = prompt('New passcode (at least 4 characters):');
        if (nw == null) return;
        try {
          const r = await privApi('POST', '/api/private/change', { passcode: cur, newPasscode: nw });
          sessionStorage.setItem('privateToken', r.token);
          toast('Passcode changed');
        } catch (e) { toast(e.message, true); }
      };
    }
    render();
  }
}

// ---------- Spa catalogue picker (modal) ----------
async function openCataloguePicker(onPick) {
  const models = await api('GET', '/api/catalogue');
  const rootEl = $('#modal-root');
  const retailers = ['All', ...new Set(models.map(mo => mo.retailer))];
  let search = '', retailer = 'All';

  function cards() {
    const q = search.toLowerCase();
    const list = models.filter(mo =>
      (retailer === 'All' || mo.retailer === retailer) &&
      (!q || (mo.name + ' ' + mo.brand + ' ' + mo.type + ' ' + mo.retailer).toLowerCase().includes(q)));
    if (!list.length) return '<p style="color:#fff;padding:20px">Nothing matches. The catalogue can be edited under Settings.</p>';
    return list.map(mo => `
      <div class="photo-card" data-pick="${esc(mo.id)}" style="cursor:pointer">
        ${mo.image ? `<img src="/catalogue-images/${esc(mo.image)}" loading="lazy" style="object-fit:contain;background:#f2f4f5">` : '<div style="height:110px;background:#e5ebee"></div>'}
        <div class="pc-body">
          <b class="small">${esc(mo.name)}</b><br>
          <span class="small muted">${esc(mo.brand)} | ${esc(mo.type)}${mo.seats ? ' | ' + esc(mo.seats) + ' seats' : ''}<br>
          ${mo.lengthM ? mo.lengthM + 'm x ' + mo.widthM + 'm' + (mo.heightM ? ' x ' + mo.heightM + 'm' : '') : 'no size on file'}${mo.docFile ? ' | has spec doc' : ''}</span>
        </div>
      </div>`).join('');
  }

  function render() {
    rootEl.innerHTML = `<div class="overlay" style="justify-content:flex-start;overflow-y:auto">
      <div style="max-width:900px;width:100%;padding:10px">
        <div class="row" style="margin-bottom:10px">
          <input type="text" id="cat-search" class="grow" placeholder="Search: brand, model, swim spa..." value="${esc(search)}" style="padding:12px;border-radius:10px;border:none">
          <select id="cat-retailer" style="max-width:170px;padding:12px;border-radius:10px;border:none">
            ${retailers.map(r => `<option ${r === retailer ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
          <button class="small-btn" id="cat-close">Close</button>
        </div>
        <div class="photo-grid">${cards()}</div>
      </div></div>`;
    $('#cat-close').onclick = () => { rootEl.innerHTML = ''; };
    $('#cat-search').oninput = () => { search = $('#cat-search').value; renderGridOnly(); };
    $('#cat-retailer').onchange = () => { retailer = $('#cat-retailer').value; renderGridOnly(); };
    wirePicks();
    $('#cat-search').focus();
  }
  function renderGridOnly() {
    rootEl.querySelector('.photo-grid').innerHTML = cards();
    wirePicks();
  }
  function wirePicks() {
    rootEl.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
      const model = models.find(mo => mo.id === el.dataset.pick);
      rootEl.innerHTML = '';
      onPick(model);
    });
  }
  render();
}

// ---------- Catalogue browser / editor ----------
async function viewCatalogue() {
  const models = await api('GET', '/api/catalogue');
  const retailers = ['All', ...new Set(models.map(mo => mo.retailer))];
  let html = `<div class="card"><h2>Spa catalogue (${models.length} models)</h2>
    <p class="small muted">Photos and sizes from Spa World, Just Spas and Alpine Spas, plus your own. Pick these on a survey to auto-fill the spa dimensions. Sizes are the retailers' published specs - trust your tape measure over the brochure.</p>
    <div class="row">
      <input type="text" id="cl-search" class="grow" placeholder="Search models...">
      <select id="cl-retailer" style="max-width:180px">${retailers.map(r => `<option>${esc(r)}</option>`).join('')}</select>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="small-btn secondary" id="cl-add">+ Add a model by hand</button>
      <a class="btn secondary small-btn" href="#/settings">Back to settings</a>
    </div>
  </div>
  <div class="card"><div class="photo-grid" id="cl-grid"></div></div>`;
  view().innerHTML = html;

  function grid() {
    const q = ($('#cl-search').value || '').toLowerCase();
    const retailer = $('#cl-retailer').value;
    const list = models.filter(mo =>
      (retailer === 'All' || mo.retailer === retailer) &&
      (!q || (mo.name + ' ' + mo.brand + ' ' + mo.type).toLowerCase().includes(q)));
    $('#cl-grid').innerHTML = list.map(mo => `
      <div class="photo-card">
        ${mo.image ? `<img src="/catalogue-images/${esc(mo.image)}" loading="lazy" style="object-fit:contain;background:#f2f4f5">` : '<div style="height:110px;background:#e5ebee"></div>'}
        <div class="pc-body">
          <b class="small">${esc(mo.name)}</b><br>
          <span class="small muted">${esc(mo.brand)} | ${esc(mo.retailer)} | ${esc(mo.type)}</span>
          <div class="row" style="margin-top:6px;gap:4px">
            <input type="number" step="0.01" style="width:31%;padding:6px" title="length m" placeholder="L" data-ml="${esc(mo.id)}" value="${esc(mo.lengthM)}">
            <input type="number" step="0.01" style="width:31%;padding:6px" title="width m" placeholder="W" data-mw="${esc(mo.id)}" value="${esc(mo.widthM)}">
            <input type="number" step="0.01" style="width:31%;padding:6px" title="height m" placeholder="H" data-mh="${esc(mo.id)}" value="${esc(mo.heightM)}">
          </div>
          <div class="row" style="margin-top:6px;gap:4px">
            <button class="small-btn" data-msave="${esc(mo.id)}">Save</button>
            <button class="small-btn secondary" data-mimg="${esc(mo.id)}">Photo</button>
            <button class="small-btn secondary" data-mdel="${esc(mo.id)}">Delete</button>
          </div>
        </div>
      </div>`).join('') || '<p class="muted">Nothing matches.</p>';
    $('#cl-grid').querySelectorAll('[data-msave]').forEach(b => b.onclick = async () => {
      const id = b.dataset.msave;
      const rec = await api('PUT', '/api/catalogue/' + id, {
        lengthM: $(`[data-ml="${id}"]`).value, widthM: $(`[data-mw="${id}"]`).value, heightM: $(`[data-mh="${id}"]`).value
      });
      Object.assign(models.find(mo => mo.id === id), rec);
      toast('Saved');
    });
    $('#cl-grid').querySelectorAll('[data-mdel]').forEach(b => b.onclick = async () => {
      if (!confirm('Remove this model from the catalogue?')) return;
      await api('DELETE', '/api/catalogue/' + b.dataset.mdel);
      models.splice(models.findIndex(mo => mo.id === b.dataset.mdel), 1);
      grid();
    });
    $('#cl-grid').querySelectorAll('[data-mimg]').forEach(b => b.onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        if (!inp.files[0]) return;
        const fd = new FormData(); fd.append('image', inp.files[0]);
        const res = await fetch('/api/catalogue/' + b.dataset.mimg + '/image', { method: 'POST', body: fd });
        const rec = await res.json();
        if (!res.ok) return toast(rec.error || 'Upload failed', true);
        Object.assign(models.find(mo => mo.id === b.dataset.mimg), rec);
        grid();
        toast('Photo added');
      };
      inp.click();
    });
  }
  $('#cl-search').oninput = grid;
  $('#cl-retailer').onchange = grid;
  $('#cl-add').onclick = async () => {
    const name = prompt('Model name (e.g. Oasis 5-seater):');
    if (!name) return;
    const rec = await api('POST', '/api/catalogue', { name, retailer: 'My own' });
    models.unshift(rec);
    grid();
    toast('Added - set its sizes and add a photo with the buttons on its card');
  };
  grid();
}

// Reusable finger/stylus drawing on a canvas. redrawBg paints the background.
function makeDrawing(canvas, redrawBg, penColor, penWidth) {
  const ctx = canvas.getContext('2d');
  let strokes = [];
  let current = null;
  let pen = penColor;

  function paintBg() { redrawBg(ctx, canvas); }
  function repaint() {
    paintBg();
    for (const s of strokes) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      s.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
    }
  }
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
  }
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    current = { color: pen, width: penWidth, points: [pos(e)] };
    strokes.push(current);
  });
  canvas.addEventListener('pointermove', e => {
    if (!current) return;
    e.preventDefault();
    current.points.push(pos(e));
    repaint();
  });
  const end = () => { current = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  paintBg();
  return {
    setPen(c) { pen = c; },
    undo() { strokes.pop(); repaint(); },
    clear() { strokes = []; repaint(); }
  };
}

// ---------- Quote editor ----------
async function viewQuote(id) {
  const Q = await api('GET', '/api/quotes/' + id);
  const job = await api('GET', '/api/jobs/' + Q.jobId);
  const customers = await api('GET', '/api/customers');
  const c = customers.find(x => x.id === job.customerId) || {};
  let invoices = (await api('GET', '/api/invoices?quoteId=' + Q.id)).sort((a, b) => (a.invoiceNumber || '').localeCompare(b.invoiceNumber || ''));

  function totals() {
    let sub = 0;
    for (const li of Q.lineItems) if (li.included !== false) sub += (parseFloat(li.qty) || 0) * (parseFloat(li.unitPrice) || 0);
    const margin = sub * ((parseFloat(Q.marginPercent) || 0) / 100);
    const ex = sub + margin, gst = ex * 0.1;
    return { sub, margin, ex, gst, total: ex + gst };
  }

  function render() {
    const t = totals();
    view().innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">Quote - ${esc(c.name)}</h2>
        <span class="badge ${QUOTE_STATUS_BADGE[Q.status]}">${Q.status}</span>
      </div>
      <p class="muted small">${esc(job.title)} | ${esc(job.siteAddress || '')} | from template: ${esc(Q.templateName)}</p>
      <div class="row">
        <a class="btn secondary" href="#/job/${job.id}">Back to job</a>
        <a class="btn secondary" href="/api/quotes/${Q.id}/pdf" target="_blank">View PDF</a>
        <button id="q-check" class="secondary">Run self-check</button>
        ${Q.status === 'draft' ? '<button id="q-send">Mark as sent</button>' : ''}
        ${Q.status === 'sent' ? '<button id="q-accept">Customer accepted</button><button id="q-decline" class="danger">Declined</button>' : ''}
      </div>
      <p class="small muted">Sent: ${fmtD(Q.dates.sent) || '-'} | Accepted: ${fmtD(Q.dates.accepted) || '-'} | Declined: ${fmtD(Q.dates.declined) || '-'}</p>
    </div>

    <div id="check-box"></div>

    <div class="card"><h2>Scope - what the customer reads</h2>
      <textarea id="q-scope" rows="6">${esc(Q.scopeDescription)}</textarea>
    </div>

    <div class="card"><h2>Line items (ex GST)</h2>
      <p class="small muted">Untick a line to leave it out. Grey notes under a line show what was pre-filled from the survey.</p>
      <table class="li-table"><thead><tr><th>In</th><th>Item</th><th>Trade</th><th>Qty</th><th>Unit</th><th>Price</th><th>Supplier</th><th>Total</th><th></th></tr></thead>
      <tbody>
      ${Q.lineItems.map((li, i) => `
        <tr>
          <td><input type="checkbox" data-inc="${i}" ${li.included !== false ? 'checked' : ''}></td>
          <td style="min-width:220px"><input type="text" data-desc="${i}" value="${esc(li.description)}">
            ${li.prefillNote ? `<div class="small muted">${esc(li.prefillNote)}</div>` : ''}</td>
          <td><select data-trade="${i}">${Object.keys(TRADE_LABELS).map(tr => `<option value="${tr}" ${li.trade === tr ? 'selected' : ''}>${TRADE_LABELS[tr]}</option>`).join('')}</select></td>
          <td><input class="num" type="number" step="0.1" data-qty="${i}" value="${esc(li.qty)}"></td>
          <td><select data-unit="${i}">${['each', 'm2', 'm', 'hour'].map(u => `<option ${li.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></td>
          <td><input class="num" type="number" step="0.01" data-price="${i}" value="${esc(li.unitPrice)}"></td>
          <td><select data-sup="${i}">${[['us', 'We supply'], ['contractor', 'Contractor'], ['customer', 'Customer']].map(([v, l]) => `<option value="${v}" ${li.supplier === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td style="white-space:nowrap">${li.included !== false ? money((parseFloat(li.qty) || 0) * (parseFloat(li.unitPrice) || 0)) : '-'}</td>
          <td><button class="small-btn secondary" data-del="${i}">x</button></td>
        </tr>
        <tr>
          <td></td>
          <td colspan="8">
            <label class="field" style="margin:0"><span class="small muted">Description on the quote/invoice PDF (what the customer reads under this item)</span>
              <textarea data-details="${i}" rows="2" style="width:100%">${esc(li.details || '')}</textarea></label>
          </td>
        </tr>`).join('')}
      </tbody></table>
      <button id="li-add" class="small-btn secondary" style="margin-top:8px">+ Add extra item</button>
      <hr>
      <div class="row" style="justify-content:space-between">
        <label class="field" style="max-width:220px"><span>Margin / coordination %</span>
          <input type="number" step="0.5" id="q-margin" value="${esc(Q.marginPercent)}"></label>
        <div class="totals">
          <div>Works subtotal: ${money(t.sub)}</div>
          <div>Margin (${esc(Q.marginPercent)}%): ${money(t.margin)}</div>
          <div>Ex GST: ${money(t.ex)} | GST: ${money(t.gst)}</div>
          <div class="grand">Total incl GST: ${money(t.total)}</div>
        </div>
      </div>
    </div>

    <div class="card"><h2>Invoices</h2>
      ${invoices.length === 0 ? `
        <p class="small muted">${Q.status === 'accepted'
          ? 'Generate the deposit / progress / final invoices from this quote\'s total (10% / 80% / 10%, matching your payment terms).'
          : 'Invoices can be generated once this quote is marked accepted.'}</p>
        <button id="inv-generate" ${Q.status !== 'accepted' ? 'disabled' : ''}>Generate invoices</button>
      ` : `
        <table class="li-table"><thead><tr><th>Invoice</th><th>Stage</th><th>Amount</th><th>Status</th><th>Due date</th><th></th></tr></thead>
        <tbody>
        ${invoices.map((inv, i) => `
          <tr>
            <td>${esc(inv.invoiceNumber)}</td>
            <td>${esc(inv.stageLabel)} (${inv.percent}%)</td>
            <td>${money(inv.total)}</td>
            <td><span class="badge ${INVOICE_STATUS_BADGE[inv.status]}">${inv.status}</span></td>
            <td><input type="date" data-inv-due="${i}" value="${esc((inv.dueDate || '').slice(0, 10))}" style="width:140px"></td>
            <td style="white-space:nowrap">
              <a class="small-btn secondary" href="/api/invoices/${inv.id}/pdf" target="_blank">PDF</a>
              ${inv.status === 'draft' ? `<button class="small-btn secondary" data-inv-send="${i}">Mark sent</button>` : ''}
              ${inv.status === 'sent' ? `<button class="small-btn" data-inv-paid="${i}">Mark paid</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody></table>
      `}
    </div>

    <div class="card"><h2>Presentation & terms</h2>
      <div class="row">
        <label class="field grow"><span>Show the customer</span>
          <select id="q-display">
            <option value="itemised" ${Q.displayMode === 'itemised' ? 'selected' : ''}>Itemised prices</option>
            <option value="lumpSum" ${Q.displayMode === 'lumpSum' ? 'selected' : ''}>One lump sum</option>
          </select></label>
        <label class="field grow"><span>Quote valid for (days)</span><input type="number" id="q-validity" value="${esc(Q.validityDays)}"></label>
      </div>
      <label class="field"><span>Payment terms</span><textarea id="q-terms" rows="3">${esc(Q.paymentTerms)}</textarea></label>
      <button id="q-save">Save quote</button>
    </div>`;

    wire();
    if (Q.checkResults) renderChecks(Q.checkResults);
  }

  function renderChecks(cr) {
    $('#check-box').innerHTML = `<div class="card"><h2>Self-check ${cr.allPassed ? '- all clear' : '- fix these before sending'}</h2>
      ${cr.results.map(r => `
        <div class="check-item ${r.ok ? 'ok' : 'fail'}">
          <span class="mark">${r.ok ? 'OK' : '!!'}</span>
          <span>${r.type === 'manual' ? `<label><input type="checkbox" data-manual="${esc(r.id)}" ${r.ok ? 'checked' : ''}> ` : ''}<b>${esc(r.label)}</b>${r.type === 'manual' ? '</label>' : ''}
          ${r.note ? `<br><span class="small">${esc(r.note)}</span>` : ''}</span>
        </div>`).join('')}
    </div>`;
    document.querySelectorAll('[data-manual]').forEach(cb => {
      cb.onchange = async () => {
        Q.manualChecks = Q.manualChecks || {};
        Q.manualChecks[cb.dataset.manual] = cb.checked;
        await api('PUT', '/api/quotes/' + Q.id, { manualChecks: Q.manualChecks });
        const cr2 = await api('POST', '/api/quotes/' + Q.id + '/check');
        Q.checkResults = cr2; renderChecks(cr2);
      };
    });
  }

  async function saveQuote() {
    const saved = await api('PUT', '/api/quotes/' + Q.id, {
      scopeDescription: Q.scopeDescription, lineItems: Q.lineItems, marginPercent: Q.marginPercent,
      displayMode: Q.displayMode, validityDays: Q.validityDays, paymentTerms: Q.paymentTerms
    });
    Object.assign(Q, saved);
  }

  function wire() {
    const bind = (attr, fn) => document.querySelectorAll('[' + attr + ']').forEach(el =>
      el.addEventListener('change', () => fn(el, +el.getAttribute(attr))));
    bind('data-inc', (el, i) => { Q.lineItems[i].included = el.checked; render(); });
    bind('data-desc', (el, i) => { Q.lineItems[i].description = el.value; });
    bind('data-trade', (el, i) => { Q.lineItems[i].trade = el.value; });
    bind('data-qty', (el, i) => { Q.lineItems[i].qty = el.value; render(); });
    bind('data-unit', (el, i) => { Q.lineItems[i].unit = el.value; });
    bind('data-price', (el, i) => { Q.lineItems[i].unitPrice = el.value; render(); });
    bind('data-sup', (el, i) => { Q.lineItems[i].supplier = el.value; });
    bind('data-details', (el, i) => { Q.lineItems[i].details = el.value; });
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { Q.lineItems.splice(+b.dataset.del, 1); render(); });
    $('#li-add').onclick = () => {
      Q.lineItems.push({ code: 'EXTRA', description: '', details: '', trade: 'general', unit: 'each', qty: 1, unitPrice: 0, supplier: 'us', included: true, notes: '', prefillNote: '' });
      render();
    };
    $('#q-scope').onchange = () => { Q.scopeDescription = $('#q-scope').value; };
    $('#q-margin').onchange = () => { Q.marginPercent = $('#q-margin').value; render(); };
    $('#q-display').onchange = () => { Q.displayMode = $('#q-display').value; };
    $('#q-validity').onchange = () => { Q.validityDays = $('#q-validity').value; };
    $('#q-terms').onchange = () => { Q.paymentTerms = $('#q-terms').value; };
    $('#q-save').onclick = () => saveQuote().then(() => toast('Quote saved')).catch(e => toast(e.message, true));
    $('#q-check').onclick = async () => {
      await saveQuote();
      const cr = await api('POST', '/api/quotes/' + Q.id + '/check');
      Q.checkResults = cr; renderChecks(cr);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    const setStatus = status => async () => {
      try {
        await saveQuote();
        const r = await api('POST', '/api/quotes/' + Q.id + '/status', { status });
        Object.assign(Q, r);
        if (status === 'accepted') invoices = await api('POST', '/api/quotes/' + Q.id + '/invoices');
        toast('Quote marked ' + status); render();
      } catch (e) {
        if (e.data && e.data.checkResults) { Q.checkResults = e.data.checkResults; renderChecks(e.data.checkResults); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        toast(e.message, true);
      }
    };
    if ($('#q-send')) $('#q-send').onclick = setStatus('sent');
    if ($('#q-accept')) $('#q-accept').onclick = setStatus('accepted');
    if ($('#q-decline')) $('#q-decline').onclick = setStatus('declined');
    if ($('#inv-generate')) $('#inv-generate').onclick = async () => {
      invoices = await api('POST', '/api/quotes/' + Q.id + '/invoices');
      toast('Invoices generated'); render();
    };
    document.querySelectorAll('[data-inv-due]').forEach(el => el.onchange = async () => {
      const inv = invoices[+el.dataset.invDue];
      inv.dueDate = el.value;
      await api('PUT', '/api/invoices/' + inv.id, { dueDate: inv.dueDate });
      toast('Due date saved');
    });
    document.querySelectorAll('[data-inv-send]').forEach(b => b.onclick = async () => {
      const inv = invoices[+b.dataset.invSend];
      Object.assign(inv, await api('POST', '/api/invoices/' + inv.id + '/status', { status: 'sent' }));
      render();
    });
    document.querySelectorAll('[data-inv-paid]').forEach(b => b.onclick = async () => {
      const inv = invoices[+b.dataset.invPaid];
      Object.assign(inv, await api('POST', '/api/invoices/' + inv.id + '/status', { status: 'paid' }));
      render();
    });
  }
  render();
}

// ---------- Invoices ----------
async function viewInvoices() {
  const [invoices, jobs, customers] = await Promise.all([
    api('GET', '/api/invoices'), api('GET', '/api/jobs'), api('GET', '/api/customers')
  ]);
  const jobById = {}; jobs.forEach(j => jobById[j.id] = j);
  const custById = {}; customers.forEach(c => custById[c.id] = c);
  const sorted = [...invoices].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const outstanding = sorted.filter(i => i.status !== 'paid');

  view().innerHTML = `
  <div class="card"><h2>Invoices</h2>
    <p class="small muted">${outstanding.length} outstanding, ${sorted.length} total. Generate invoices from an accepted quote's page.</p>
    <table class="li-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Job</th><th>Stage</th><th>Amount</th><th>Status</th><th>Due</th><th></th></tr></thead>
    <tbody>
    ${sorted.map(inv => {
      const job = jobById[inv.jobId] || {};
      const cust = custById[job.customerId] || {};
      return `<tr>
        <td><a href="#/invoice/${inv.id}">${esc(inv.invoiceNumber)}</a></td>
        <td>${esc(cust.name || '')}</td>
        <td>${esc(job.title || '')}</td>
        <td>${esc(inv.stageLabel)} (${inv.percent}%)</td>
        <td>${money(inv.total)}</td>
        <td><span class="badge ${INVOICE_STATUS_BADGE[inv.status]}">${inv.status}</span></td>
        <td>${fmtD(inv.dueDate) || '-'}</td>
        <td><a class="small-btn secondary" href="/api/invoices/${inv.id}/pdf" target="_blank">PDF</a></td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" class="muted">No invoices yet.</td></tr>'}
    </tbody></table>
  </div>`;
}

async function viewInvoice(id) {
  const inv = await api('GET', '/api/invoices/' + id);
  const job = await api('GET', '/api/jobs/' + inv.jobId);
  const customers = await api('GET', '/api/customers');
  const c = customers.find(x => x.id === job.customerId) || {};

  function render() {
    view().innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${esc(inv.invoiceNumber)} - ${esc(c.name)}</h2>
        <span class="badge ${INVOICE_STATUS_BADGE[inv.status]}">${inv.status}</span>
      </div>
      <p class="muted small">${esc(inv.stageLabel)} (${inv.percent}%) | ${esc(job.title)} | Re: Quote ${esc(inv.quoteNumber || '')}</p>
      <div class="row">
        <a class="btn secondary" href="#/quote/${inv.quoteId}">Back to quote</a>
        <a class="btn secondary" href="/api/invoices/${inv.id}/pdf" target="_blank">View PDF</a>
        ${inv.status === 'draft' ? '<button id="i-send">Mark as sent</button>' : ''}
        ${inv.status === 'sent' ? '<button id="i-paid">Mark as paid</button>' : ''}
      </div>
      <p class="small muted">Sent: ${fmtD(inv.dates.sent) || '-'} | Paid: ${fmtD(inv.dates.paid) || '-'}</p>
    </div>

    <div class="card"><h2>Amount</h2>
      <div class="totals">
        <div>Subtotal: ${money(inv.subtotal)}</div>
        <div>GST: ${money(inv.gst)}</div>
        <div class="grand">Amount due: ${money(inv.total)}</div>
      </div>
    </div>

    <div class="card"><h2>Details</h2>
      <label class="field"><span>Due date</span><input type="date" id="i-due" value="${esc((inv.dueDate || '').slice(0, 10))}"></label>
      <label class="field"><span>Notes (printed on the PDF)</span><textarea id="i-notes" rows="3">${esc(inv.notes || '')}</textarea></label>
      <button id="i-save">Save</button>
    </div>`;

    $('#i-due').onchange = () => { inv.dueDate = $('#i-due').value; };
    $('#i-notes').onchange = () => { inv.notes = $('#i-notes').value; };
    $('#i-save').onclick = async () => {
      Object.assign(inv, await api('PUT', '/api/invoices/' + inv.id, { dueDate: inv.dueDate, notes: inv.notes }));
      toast('Invoice saved');
    };
    if ($('#i-send')) $('#i-send').onclick = async () => {
      Object.assign(inv, await api('POST', '/api/invoices/' + inv.id + '/status', { status: 'sent' }));
      toast('Marked as sent'); render();
    };
    if ($('#i-paid')) $('#i-paid').onclick = async () => {
      Object.assign(inv, await api('POST', '/api/invoices/' + inv.id + '/status', { status: 'paid' }));
      toast('Marked as paid'); render();
    };
  }
  render();
}

// ---------- Spec editor ----------
async function viewSpec(id) {
  const S = await api('GET', '/api/specs/' + id);
  const job = await api('GET', '/api/jobs/' + S.jobId);
  const photos = (job.survey && job.survey.photos) || [];

  function render() {
    view().innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${esc(S.tradeLabel || S.trade)} spec - ${esc(job.title)}</h2>
        <span class="badge ${S.status === 'final' ? 'green' : ''}">${S.status}</span>
      </div>
      <div class="row">
        <a class="btn secondary" href="#/job/${job.id}">Back to job</a>
        <a class="btn secondary" href="/api/specs/${S.id}/pdf" target="_blank">View PDF</a>
        <button id="sp-check" class="secondary">Run self-check</button>
        ${S.status !== 'final' ? '<button id="sp-final">Finalise (ready to send)</button>' : ''}
      </div>
      <p class="small muted">Text or email the PDF to the contractor. Everything they need is on it - they should never have to ring you to ask where it goes.</p>
    </div>
    <div id="check-box"></div>
    <div class="card">
      <label class="field"><span>Scope for this trade (what they are doing)</span><textarea id="sp-scope" rows="5">${esc(S.scope)}</textarea></label>
      <label class="field"><span>Position - exactly where things go</span><textarea id="sp-pos" rows="3">${esc(S.position)}</textarea></label>
      <label class="field"><span>Dimensions and levels</span><textarea id="sp-dim" rows="3">${esc(S.dimensions)}</textarea></label>
      <label class="field"><span>Site access</span><textarea id="sp-access" rows="2">${esc(S.accessNotes)}</textarea></label>
      <label class="field"><span>Hazards</span><textarea id="sp-hazards" rows="2">${esc(S.hazards)}</textarea></label>
    </div>
    <div class="card"><h2>Materials - who supplies what</h2>
      <div id="mat-rows"></div>
      <button class="small-btn secondary" id="mat-add">+ Add material</button>
    </div>
    <div class="card"><h2>Questions to confirm before starting</h2>
      <p class="small muted">These surface confusion before the day, not on it.</p>
      <div id="qq-rows"></div>
      <button class="small-btn secondary" id="qq-add">+ Add question</button>
    </div>
    <div class="card"><h2>Attached to the PDF</h2>
      ${job.survey && job.survey.spaModel ? `
      <div class="check-row"><input type="checkbox" id="sp-spadoc" ${S.includeSpaDoc !== false && (S.includeSpaDoc === true || S.trade === 'electrical' || S.trade === 'crane') ? 'checked' : ''}>
        <label for="sp-spadoc">Manufacturer spec / delivery guide for the ${esc(job.survey.spaModel.name)} (electrical placement)</label></div>`
      : '<p class="small muted">Pick the spa from the catalogue on the survey and its manufacturer spec doc can ride along here.</p>'}
      ${(job.documents || []).length ? (job.documents || []).map(d => `
      <div class="check-row"><input type="checkbox" data-adoc="${esc(d.file)}" ${(S.attachDocs || []).includes(d.file) ? 'checked' : ''}>
        <label>${esc(d.label)}</label></div>`).join('')
      : '<p class="small muted">Plans uploaded on the job page can be ticked here to go out with this spec.</p>'}
    </div>

    <div class="card"><h2>Photos on this spec</h2>
      <div class="photo-grid">${photos.map(p => `
        <div class="photo-card">
          <img src="/uploads/${esc(p.annotatedFile || p.file)}">
          <div class="pc-body"><label class="small"><input type="checkbox" data-ph="${esc(p.id)}" ${S.photoIds.includes(p.id) ? 'checked' : ''}> ${esc(p.caption || 'include')}</label></div>
        </div>`).join('') || '<p class="muted">No survey photos on this job.</p>'}</div>
      <div class="check-row"><input type="checkbox" id="sp-sketch" ${S.includeSketch ? 'checked' : ''}><label for="sp-sketch">Include the site sketch</label></div>
    </div>
    <div class="card"><button id="sp-save">Save spec</button></div>`;

    function renderMats() {
      $('#mat-rows').innerHTML = S.materials.map((mt, i) => `
        <div class="row" style="margin:6px 0">
          <input type="text" class="grow" data-mitem="${i}" value="${esc(mt.item)}" placeholder="material / item">
          <select data-msup="${i}" style="max-width:190px">${['We supply', 'Contractor supplies', 'Customer supplies'].map(o => `<option ${mt.suppliedBy === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
          <button class="small-btn secondary" data-mdel="${i}">x</button>
        </div>`).join('');
      document.querySelectorAll('[data-mitem]').forEach(el => el.oninput = () => { S.materials[+el.dataset.mitem].item = el.value; });
      document.querySelectorAll('[data-msup]').forEach(el => el.onchange = () => { S.materials[+el.dataset.msup].suppliedBy = el.value; });
      document.querySelectorAll('[data-mdel]').forEach(b => b.onclick = () => { S.materials.splice(+b.dataset.mdel, 1); renderMats(); });
    }
    function renderQs() {
      $('#qq-rows').innerHTML = S.questions.map((q, i) => `
        <div class="row" style="margin:6px 0">
          <input type="text" class="grow" data-q="${i}" value="${esc(q)}">
          <button class="small-btn secondary" data-qdel="${i}">x</button>
        </div>`).join('');
      document.querySelectorAll('[data-q]').forEach(el => el.oninput = () => { S.questions[+el.dataset.q] = el.value; });
      document.querySelectorAll('[data-qdel]').forEach(b => b.onclick = () => { S.questions.splice(+b.dataset.qdel, 1); renderQs(); });
    }
    renderMats(); renderQs();
    $('#mat-add').onclick = () => { S.materials.push({ item: '', suppliedBy: 'We supply' }); renderMats(); };
    $('#qq-add').onclick = () => { S.questions.push(''); renderQs(); };
    document.querySelectorAll('[data-ph]').forEach(cb => cb.onchange = () => {
      const pid = cb.dataset.ph;
      if (cb.checked) { if (!S.photoIds.includes(pid)) S.photoIds.push(pid); }
      else S.photoIds = S.photoIds.filter(x => x !== pid);
    });
    $('#sp-sketch').onchange = () => { S.includeSketch = $('#sp-sketch').checked; };
    if ($('#sp-spadoc')) $('#sp-spadoc').onchange = () => { S.includeSpaDoc = $('#sp-spadoc').checked; };
    document.querySelectorAll('[data-adoc]').forEach(cb => cb.onchange = () => {
      S.attachDocs = S.attachDocs || [];
      if (cb.checked) { if (!S.attachDocs.includes(cb.dataset.adoc)) S.attachDocs.push(cb.dataset.adoc); }
      else S.attachDocs = S.attachDocs.filter(x => x !== cb.dataset.adoc);
    });

    async function saveSpec() {
      collect();
      const saved = await api('PUT', '/api/specs/' + S.id, {
        scope: S.scope, position: S.position, dimensions: S.dimensions, accessNotes: S.accessNotes,
        hazards: S.hazards, materials: S.materials, questions: S.questions,
        photoIds: S.photoIds, includeSketch: S.includeSketch, manualChecks: S.manualChecks,
        attachDocs: S.attachDocs || [], includeSpaDoc: S.includeSpaDoc
      });
      Object.assign(S, saved);
    }
    function collect() {
      S.scope = $('#sp-scope').value; S.position = $('#sp-pos').value; S.dimensions = $('#sp-dim').value;
      S.accessNotes = $('#sp-access').value; S.hazards = $('#sp-hazards').value;
      S.questions = S.questions.filter(q => q.trim());
    }
    $('#sp-save').onclick = () => saveSpec().then(() => { toast('Spec saved'); render(); }).catch(e => toast(e.message, true));
    $('#sp-check').onclick = async () => {
      await saveSpec();
      const cr = await api('POST', '/api/specs/' + S.id + '/check');
      S.checkResults = cr; renderChecks(cr);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    if ($('#sp-final')) $('#sp-final').onclick = async () => {
      try {
        await saveSpec();
        const r = await api('POST', '/api/specs/' + S.id + '/finalise');
        Object.assign(S, r); toast('Spec finalised - send the PDF'); render();
      } catch (e) {
        if (e.data && e.data.checkResults) { S.checkResults = e.data.checkResults; renderChecks(e.data.checkResults); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        toast(e.message, true);
      }
    };
    if (S.checkResults) renderChecks(S.checkResults);

    function renderChecks(cr) {
      $('#check-box').innerHTML = `<div class="card"><h2>Self-check ${cr.allPassed ? '- all clear' : '- fix these before sending'}</h2>
        ${cr.results.map(r => `
          <div class="check-item ${r.ok ? 'ok' : 'fail'}">
            <span class="mark">${r.ok ? 'OK' : '!!'}</span>
            <span>${r.type === 'manual' ? `<label><input type="checkbox" data-smanual="${esc(r.id)}" ${r.ok ? 'checked' : ''}> ` : ''}<b>${esc(r.label)}</b>${r.type === 'manual' ? '</label>' : ''}
            ${r.note ? `<br><span class="small">${esc(r.note)}</span>` : ''}</span>
          </div>`).join('')}
      </div>`;
      document.querySelectorAll('[data-smanual]').forEach(cb => {
        cb.onchange = async () => {
          S.manualChecks = S.manualChecks || {};
          S.manualChecks[cb.dataset.smanual] = cb.checked;
          await api('PUT', '/api/specs/' + S.id, { manualChecks: S.manualChecks });
          const cr2 = await api('POST', '/api/specs/' + S.id + '/check');
          S.checkResults = cr2; renderChecks(cr2);
        };
      });
    }
  }
  render();
}

// ---------- Settings ----------
async function viewSettings() {
  const s = await api('GET', '/api/settings');
  const biz = s.business, tr = s.tracker, ut = s.updateTemplates;

  const bizFields = [
    ['businessName', 'Business name'], ['abn', 'ABN'], ['licenceNo', 'Pool builder licence number'],
    ['phone', 'Phone'], ['email', 'Email'], ['website', 'Website'], ['address', 'Address / suburb'],
    ['senderName', 'Your name (signs off customer texts)']
  ];
  const bankFields = [
    ['bankAccountName', 'Account name'], ['bankBSB', 'BSB'], ['bankAccountNumber', 'Account number']
  ];

  view().innerHTML = `
  <div class="card"><h2>Business details</h2>
    <p class="small muted">These go on every quote and spec PDF. The self-check blocks sending while placeholders remain.</p>
    ${bizFields.map(([k, l]) => `<label class="field"><span>${l}</span><input type="text" id="bz-${k}" value="${esc(biz[k])}"></label>`).join('')}
    <div class="row">
      <label class="field grow"><span>Default margin %</span><input type="number" id="bz-margin" value="${esc(biz.defaultMarginPercent)}"></label>
      <label class="field grow"><span>Default quote validity (days)</span><input type="number" id="bz-validity" value="${esc(biz.validityDaysDefault)}"></label>
    </div>
    <label class="field"><span>Default payment terms</span><textarea id="bz-terms" rows="3">${esc(biz.paymentTermsDefault)}</textarea></label>
    <button id="bz-save">Save business details</button>
  </div>

  <div class="card"><h2>Bank details</h2>
    <p class="small muted">Printed on every quote/invoice PDF under Terms of Payment.</p>
    ${bankFields.map(([k, l]) => `<label class="field"><span>${l}</span><input type="text" id="bz-${k}" value="${esc(biz[k])}"></label>`).join('')}
    <button id="bz-bank-save">Save bank details</button>
  </div>

  <div class="card"><h2>Quote numbering</h2>
    <div class="row">
      <label class="field grow"><span>Prefix</span><input type="text" id="bz-quoteNumberPrefix" value="${esc(biz.quoteNumberPrefix || 'QU-')}"></label>
      <label class="field grow"><span>Next quote number</span><input type="number" id="bz-nextQuoteNumber" value="${esc(biz.nextQuoteNumber || 1)}"></label>
    </div>
    <p class="small muted">Assigned once, when a quote is created (e.g. ${esc(biz.quoteNumberPrefix || 'QU-')}${String(biz.nextQuoteNumber || 1).padStart(4, '0')} next). Only change this if you need to match your existing numbering.</p>
    <button id="bz-quotenum-save">Save quote numbering</button>
  </div>

  <div class="card"><h2>Legal / safety notes</h2>
    <p class="small muted">Printed at the foot of every quote and invoice PDF.</p>
    <label class="field"><span>Legal notes</span><textarea id="bz-legalNotesDefault" rows="6">${esc(biz.legalNotesDefault || '')}</textarea></label>
    <button id="bz-legal-save">Save legal notes</button>
  </div>

  <div class="card"><h2>Price templates</h2>
    <p class="small muted">Base pricing per install type. These encode your judgement - keep them current.</p>
    <a class="btn secondary" href="#/templates">Edit price templates</a>
  </div>

  <div class="card"><h2>Spa catalogue</h2>
    <p class="small muted">Spa models with photos and sizes from Spa World, Just Spas and Alpine Spas. Picked on surveys to auto-fill dimensions.</p>
    <a class="btn secondary" href="#/catalogue">Open the catalogue</a>
  </div>

  <div class="card"><h2>"Sitting too long" limits</h2>
    <p class="small muted">Days a job can sit in a stage before it's flagged on This Week.</p>
    ${STAGES.filter(st => st !== 'invoiced').map(st => `
      <div class="row" style="margin:4px 0"><span style="min-width:140px">${STAGE_LABELS[st]}</span>
      <input type="number" style="width:90px" id="th-${st}" value="${esc(tr.stageThresholdDays[st] != null ? tr.stageThresholdDays[st] : '')}"> <span class="muted small">days</span></div>`).join('')}
    <button id="th-save" style="margin-top:8px">Save limits</button>
  </div>

  <div class="card"><h2>Customer update messages</h2>
    <p class="small muted">One template per stage. Placeholders: {firstName} {installType} {nextAction} {senderName}</p>
    ${STAGES.map(st => `<label class="field"><span>${STAGE_LABELS[st]}</span><textarea id="ut-${st}" rows="2">${esc(ut[st] || '')}</textarea></label>`).join('')}
    <button id="ut-save">Save messages</button>
  </div>

  ${checklistEditor('quote', 'Quote self-check', s.quoteChecklist)}
  ${checklistEditor('spec', 'Contractor spec self-check', s.specChecklist)}
  `;

  $('#bz-save').onclick = async () => {
    const b = { ...biz };
    for (const [k] of bizFields) b[k] = $('#bz-' + k).value;
    b.defaultMarginPercent = parseFloat($('#bz-margin').value) || 0;
    b.validityDaysDefault = parseInt($('#bz-validity').value) || 30;
    b.paymentTermsDefault = $('#bz-terms').value;
    Object.assign(biz, b);
    await api('PUT', '/api/settings', { business: b });
    toast('Business details saved');
  };
  $('#bz-bank-save').onclick = async () => {
    const b = { ...biz };
    for (const [k] of bankFields) b[k] = $('#bz-' + k).value;
    Object.assign(biz, b);
    await api('PUT', '/api/settings', { business: b });
    toast('Bank details saved');
  };
  $('#bz-quotenum-save').onclick = async () => {
    const b = { ...biz };
    b.quoteNumberPrefix = $('#bz-quoteNumberPrefix').value || 'QU-';
    b.nextQuoteNumber = parseInt($('#bz-nextQuoteNumber').value) || 1;
    Object.assign(biz, b);
    await api('PUT', '/api/settings', { business: b });
    toast('Quote numbering saved');
  };
  $('#bz-legal-save').onclick = async () => {
    const b = { ...biz };
    b.legalNotesDefault = $('#bz-legalNotesDefault').value;
    Object.assign(biz, b);
    await api('PUT', '/api/settings', { business: b });
    toast('Legal notes saved');
  };
  $('#th-save').onclick = async () => {
    const days = {};
    for (const st of STAGES) {
      const el = $('#th-' + st);
      if (el && el.value !== '') days[st] = parseInt(el.value);
    }
    await api('PUT', '/api/settings', { tracker: { ...tr, stageThresholdDays: days } });
    toast('Limits saved');
  };
  $('#ut-save').onclick = async () => {
    const t = { ...ut };
    for (const st of STAGES) t[st] = $('#ut-' + st).value;
    await api('PUT', '/api/settings', { updateTemplates: t });
    toast('Messages saved');
  };
  wireChecklist('quote', s.quoteChecklist);
  wireChecklist('spec', s.specChecklist);

  function checklistEditor(kind, title, list) {
    return `<div class="card"><h2>${title}</h2>
      <p class="small muted">Automatic checks can be switched off or reworded. Anything you add becomes a manual tick-box before send.</p>
      <div id="cl-${kind}-rows">${list.map((c, i) => `
        <div class="row" style="margin:6px 0">
          <input type="checkbox" data-clen="${kind}-${i}" ${c.enabled !== false ? 'checked' : ''} title="enabled">
          <input type="text" class="grow" data-cll="${kind}-${i}" value="${esc(c.label)}">
          <button class="small-btn secondary" data-cld="${kind}-${i}">x</button>
        </div>`).join('')}</div>
      <div class="row">
        <button class="small-btn secondary" id="cl-${kind}-add">+ Add my own check</button>
        <button class="small-btn" id="cl-${kind}-save">Save checklist</button>
      </div>
    </div>`;
  }
  function wireChecklist(kind, list) {
    document.querySelectorAll(`[data-clen^="${kind}-"]`).forEach(cb => cb.onchange = () => { list[+cb.dataset.clen.split('-')[1]].enabled = cb.checked; });
    document.querySelectorAll(`[data-cll^="${kind}-"]`).forEach(inp => inp.oninput = () => { list[+inp.dataset.cll.split('-')[1]].label = inp.value; });
    document.querySelectorAll(`[data-cld^="${kind}-"]`).forEach(b => b.onclick = () => { list.splice(+b.dataset.cld.split('-')[1], 1); viewSettingsPatch(kind, list); });
    $(`#cl-${kind}-add`).onclick = () => {
      const label = prompt('What should be checked before sending?');
      if (!label) return;
      list.push({ id: 'custom_' + Date.now(), label, enabled: true });
      viewSettingsPatch(kind, list);
    };
    $(`#cl-${kind}-save`).onclick = () => viewSettingsPatch(kind, list);
  }
  async function viewSettingsPatch(kind, list) {
    await api('PUT', '/api/settings', kind === 'quote' ? { quoteChecklist: list } : { specChecklist: list });
    toast('Checklist saved');
    viewSettings();
  }
}

// ---------- Templates ----------
async function viewTemplates() {
  const templates = await api('GET', '/api/templates');
  view().innerHTML = `<div class="card"><h2>Price templates</h2>
    <p class="small muted">One per install type. New quotes start from these prices.</p>
    ${templates.map(t => `<div class="item-row">
      <span class="grow"><a class="title" href="#/template/${t.id}">${esc(t.name)}</a><br>
      <span class="small muted">${t.lineItems.length} line items</span></span>
    </div>`).join('')}
    <hr><button id="t-new">+ New template</button>
    <a class="btn secondary" href="#/settings" style="margin-left:8px">Back to settings</a>
  </div>`;
  $('#t-new').onclick = async () => {
    const name = prompt('Template name (e.g. Swim spa on sloping block):');
    if (!name) return;
    const t = await api('POST', '/api/templates', { name, installType: name.toLowerCase(), lineItems: [] });
    location.hash = '#/template/' + t.id;
  };
}

async function viewTemplate(id) {
  const T = await api('GET', '/api/templates').then(list => list.find(t => t.id === id));
  if (!T) { view().innerHTML = '<div class="card">Template not found.</div>'; return; }
  const PREFILLS = [['', 'none'], ['slab_area', 'Size from spa dimensions (slab)'], ['crane', 'Include only if crane needed'], ['electrical_run', 'Qty = distance to switchboard'], ['plumbing_run', 'Qty = distance to water/drain'], ['tight_access', 'Include only if access is tight']];

  function render() {
    view().innerHTML = `<div class="card">
      <h2>Template: ${esc(T.name)}</h2>
      <label class="field"><span>Name</span><input type="text" id="t-name" value="${esc(T.name)}"></label>
      <label class="field"><span>Install type</span><input type="text" id="t-type" value="${esc(T.installType)}"></label>
      <label class="field"><span>Description (for you, not the customer)</span><textarea id="t-desc" rows="2">${esc(T.description)}</textarea></label>
      <h3>Line items (prices ex GST)</h3>
      <table class="li-table"><thead><tr><th>Item</th><th>Trade</th><th>Unit</th><th>Default qty</th><th>Price</th><th>Supplier</th><th>Auto-fill from survey</th><th></th></tr></thead><tbody>
      ${T.lineItems.map((li, i) => `<tr>
        <td style="min-width:200px"><input type="text" data-desc="${i}" value="${esc(li.description)}"></td>
        <td><select data-trade="${i}">${Object.keys(TRADE_LABELS).map(tr => `<option value="${tr}" ${li.trade === tr ? 'selected' : ''}>${TRADE_LABELS[tr]}</option>`).join('')}</select></td>
        <td><select data-unit="${i}">${['each', 'm2', 'm', 'hour'].map(u => `<option ${li.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></td>
        <td><input class="num" type="number" step="0.1" data-qty="${i}" value="${esc(li.defaultQty)}"></td>
        <td><input class="num" type="number" step="0.01" data-price="${i}" value="${esc(li.unitPrice)}"></td>
        <td><select data-sup="${i}">${[['us', 'We supply'], ['contractor', 'Contractor'], ['customer', 'Customer']].map(([v, l]) => `<option value="${v}" ${li.supplier === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
        <td><select data-pf="${i}">${PREFILLS.map(([v, l]) => `<option value="${v}" ${(li.prefill || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
        <td><button class="small-btn secondary" data-del="${i}">x</button></td>
      </tr>
      <tr>
        <td></td>
        <td colspan="7">
          <label class="field" style="margin:0"><span class="small muted">Description on the quote/invoice PDF</span>
            <textarea data-details="${i}" rows="2" style="width:100%">${esc(li.details || '')}</textarea></label>
        </td>
      </tr>`).join('')}
      </tbody></table>
      <div class="row" style="margin-top:10px">
        <button class="small-btn secondary" id="t-addli">+ Add line item</button>
        <button id="t-save">Save template</button>
        <button class="danger" id="t-del">Delete template</button>
        <a class="btn secondary" href="#/templates">Back</a>
      </div>
    </div>`;
    const bind = (attr, fn) => document.querySelectorAll('[' + attr + ']').forEach(el =>
      el.addEventListener('change', () => fn(el, +el.getAttribute(attr))));
    bind('data-desc', (el, i) => T.lineItems[i].description = el.value);
    bind('data-trade', (el, i) => T.lineItems[i].trade = el.value);
    bind('data-unit', (el, i) => T.lineItems[i].unit = el.value);
    bind('data-qty', (el, i) => T.lineItems[i].defaultQty = parseFloat(el.value) || 0);
    bind('data-price', (el, i) => T.lineItems[i].unitPrice = parseFloat(el.value) || 0);
    bind('data-sup', (el, i) => T.lineItems[i].supplier = el.value);
    bind('data-pf', (el, i) => T.lineItems[i].prefill = el.value || null);
    bind('data-details', (el, i) => T.lineItems[i].details = el.value);
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { T.lineItems.splice(+b.dataset.del, 1); render(); });
    $('#t-addli').onclick = () => { T.lineItems.push({ code: 'ITEM', description: '', details: '', trade: 'general', unit: 'each', defaultQty: 1, unitPrice: 0, supplier: 'us', prefill: null, notes: '' }); render(); };
    $('#t-save').onclick = async () => {
      T.name = $('#t-name').value; T.installType = $('#t-type').value; T.description = $('#t-desc').value;
      await api('PUT', '/api/templates/' + T.id, T);
      toast('Template saved');
    };
    $('#t-del').onclick = async () => {
      if (!confirm('Delete this template? Existing quotes keep their prices.')) return;
      await api('DELETE', '/api/templates/' + T.id);
      location.hash = '#/templates';
    };
  }
  render();
}
