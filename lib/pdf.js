// PDF output for quotes and contractor spec sheets. Uses pdfkit (pure JS, no
// browser needed). Quote layout matches the founder's real letterhead
// (logo, two-column header, category-style line items, bank details, legal
// notes) - built directly from his actual sent quotes, not a generic template.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const storage = require('./storage');
const { quoteTotals } = require('./prefill');

const M = 50; // page margin
const PAGE_W = 595.28, PAGE_H = 841.89;
const W = PAGE_W - M * 2; // usable width
const LOGO_PATH = path.join(__dirname, '..', 'public', 'logo.png');
const WAVE_PATH = path.join(__dirname, '..', 'public', 'wave.png');

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, ' · ');
}

function newDoc(res, filename) {
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
  doc.pipe(res);
  return doc;
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > PAGE_H - M - 20) doc.addPage();
}

// Logo top-left, business details top-right - matches the real letterhead.
function letterhead(doc) {
  const biz = storage.getConfig('business.json', {});
  let logoBottom = M;
  if (fs.existsSync(LOGO_PATH)) {
    try {
      const dims = doc.openImage(LOGO_PATH);
      const w = 160, h = w * (dims.height / dims.width);
      doc.image(LOGO_PATH, M, M, { width: w });
      logoBottom = M + h;
    } catch (e) { /* logo unreadable - carry on without it */ }
  }
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0a2540')
    .text(biz.businessName || 'Your Business Name', M, M, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#444');
  const addrLines = (biz.address || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const line of addrLines) doc.text(line, { width: W, align: 'right' });
  doc.text('Lic No: ' + (biz.licenceNo || 'XXXXX') + '  |  ABN: ' + (biz.abn || 'XXXXX'), { width: W, align: 'right' });
  doc.moveDown(0.4);
  doc.text('P. ' + (biz.phone || ''), { width: W, align: 'right' });
  doc.text('E. ' + (biz.email || ''), { width: W, align: 'right' });
  if (biz.website) doc.text('W. ' + biz.website, { width: W, align: 'right' });
  doc.fillColor('#000');
  doc.y = Math.max(logoBottom, doc.y) + 14;
  doc.x = M;
  return biz;
}

function sectionTitle(doc, text) {
  ensureSpace(doc, 60);
  doc.moveDown(0.5);
  doc.x = M;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0a2540').text(text.toUpperCase(), M, doc.y, { width: W });
  doc.fillColor('#000');
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10);
}

function kv(doc, label, value) {
  doc.x = M;
  doc.font('Helvetica-Bold').fontSize(10).text(label + ': ', M, doc.y, { continued: true });
  doc.font('Helvetica').text(value || '-');
}

// Thin wave graphic across the bottom of a page, matching the letterhead.
function footerWave(doc) {
  if (!fs.existsSync(WAVE_PATH)) return;
  try {
    const dims = doc.openImage(WAVE_PATH);
    const h = 42, w = PAGE_W;
    doc.image(WAVE_PATH, 0, PAGE_H - h, { width: w, height: h });
  } catch (e) { /* decorative only */ }
}
function withFooters(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    footerWave(doc);
  }
}

// ---- Quote PDF --------------------------------------------------------------

function quotePdf(res, quote, job, customer) {
  const doc = newDoc(res, (quote.quoteNumber || quote.id) + '.pdf');
  const biz = letterhead(doc);

  doc.font('Helvetica-Bold').fontSize(22).fillColor('#0a2540').text('Quotation');
  doc.fillColor('#000');
  doc.moveDown(0.6);

  const blockTop = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).text('To');
  doc.moveDown(0.15);
  doc.font('Helvetica-Bold').fontSize(10).text(customer ? customer.name : '');
  doc.font('Helvetica').fontSize(9.5).fillColor('#333');
  if (job.siteAddress) doc.text(job.siteAddress);
  if (customer && customer.email) doc.text(customer.email);
  doc.fillColor('#000');

  doc.font('Helvetica').fontSize(9.5)
    .text(fmtDate(quote.dates && quote.dates.created), M, blockTop, { width: W, align: 'right' });
  doc.text('Quote No: ' + (quote.quoteNumber || quote.id), { width: W, align: 'right' });
  if (quote.validityDays) {
    const expiry = quote.dates && quote.dates.created
      ? new Date(new Date(quote.dates.created).getTime() + quote.validityDays * 86400000) : null;
    doc.text('Expiry Date: ' + (expiry ? fmtDate(expiry.toISOString()) : ''), { width: W, align: 'right' });
  }
  doc.x = M;
  doc.y = Math.max(doc.y, blockTop + 70);
  doc.moveDown(1);

  const totals = quoteTotals(quote);

  if (quote.displayMode === 'lumpSum') {
    doc.font('Helvetica').fontSize(10).text(quote.scopeDescription || '', { lineGap: 2 });
    doc.moveDown(1);
  } else {
    // Description | Amount two-column table, matching the real letterhead:
    // a bold category title, the plain-language detail paragraph beneath it,
    // and a single line total on the right - no qty/unit-price breakdown
    // shown to the customer.
    const colAmountW = 100, colDescW = W - colAmountW - 10;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0a2540');
    doc.text('Description', M, doc.y, { width: colDescW, continued: false });
    doc.text('Amount', M + colDescW + 10, doc.y - doc.currentLineHeight(), { width: colAmountW, align: 'right' });
    doc.fillColor('#000');
    doc.moveDown(0.3);
    doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor('#0a2540').lineWidth(0.75).stroke();
    doc.moveDown(0.4);

    for (const li of quote.lineItems || []) {
      if (li.included === false) continue;
      const lineTotal = (parseFloat(li.qty) || 0) * (parseFloat(li.unitPrice) || 0);
      ensureSpace(doc, 50);
      const rowTop = doc.y;
      doc.font('Helvetica-Bold').fontSize(9.5).text((li.description || '').toUpperCase(), M, rowTop, { width: colDescW });
      if (li.details) {
        doc.font('Helvetica').fontSize(9).fillColor('#333').text(li.details, M, doc.y, { width: colDescW, lineGap: 1.5 });
        doc.fillColor('#000');
      }
      const descBottom = doc.y;
      doc.font('Helvetica').fontSize(9.5).text(money(lineTotal), M + colDescW + 10, rowTop, { width: colAmountW, align: 'right' });
      doc.x = M;
      doc.y = descBottom;
      doc.moveDown(0.6);
      ensureSpace(doc, 4);
      doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke();
      doc.moveDown(0.4);
    }

    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9.5);
    if (totals.margin > 0) {
      doc.text('Subtotal', M, doc.y, { width: colDescW });
      doc.text(money(totals.subtotal), M + colDescW + 10, doc.y - doc.currentLineHeight(), { width: colAmountW, align: 'right' });
      doc.text('Project management and coordination', M, doc.y, { width: colDescW });
      doc.text(money(totals.margin), M + colDescW + 10, doc.y - doc.currentLineHeight(), { width: colAmountW, align: 'right' });
    }
    doc.text('Subtotal', M, doc.y, { width: colDescW });
    doc.text(money(totals.exGst), M + colDescW + 10, doc.y - doc.currentLineHeight(), { width: colAmountW, align: 'right' });
    doc.text('GST 10%', M, doc.y, { width: colDescW });
    doc.text(money(totals.gst), M + colDescW + 10, doc.y - doc.currentLineHeight(), { width: colAmountW, align: 'right' });
    doc.x = M;
    doc.moveDown(0.3);
    doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor('#0a2540').lineWidth(0.75).stroke();
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0a2540');
    doc.text('Total', M, doc.y, { width: colDescW });
    doc.text('AUD ' + money(totals.total).replace('$', ''), M + colDescW + 10, doc.y - doc.currentLineHeight(), { width: colAmountW, align: 'right' });
    doc.fillColor('#000');
  }

  if (quote.notes) {
    sectionTitle(doc, 'Notes');
    doc.font('Helvetica').fontSize(9).text(quote.notes, { lineGap: 3 });
  }

  ensureSpace(doc, 140);
  doc.moveDown(1);
  doc.x = M;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0a2540').text('Terms of Payment', M, doc.y, { width: W, align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(0.3);
  doc.x = M;
  doc.font('Helvetica').fontSize(8.5)
    .text(quote.paymentTerms || biz.paymentTermsDefault || '', M, doc.y, { width: W, align: 'center', lineGap: 2 });
  doc.moveDown(0.3);
  if (biz.bankAccountName) {
    doc.x = M;
    doc.text('Bank Details: Acc Name: ' + biz.bankAccountName +
      (biz.bankBSB ? '  |  BSB: ' + biz.bankBSB : '') +
      (biz.bankAccountNumber ? '  |  ACC No: ' + biz.bankAccountNumber : ''), M, doc.y, { width: W, align: 'center' });
  }
  doc.moveDown(0.6);
  doc.x = M;
  doc.fontSize(8).fillColor('#555')
    .text(biz.legalNotesDefault || '', M, doc.y, { width: W, align: 'center', lineGap: 2 });
  doc.fillColor('#000');

  withFooters(doc);
  doc.end();
}

// ---- Invoice PDF -------------------------------------------------------------
// One of three staged invoices (deposit / progress / final) generated from an
// accepted quote's total, matching the founder's real 10/80/10 payment terms.

function invoicePdf(res, invoice, job, customer) {
  const doc = newDoc(res, (invoice.invoiceNumber || invoice.id) + '.pdf');
  const biz = letterhead(doc);

  doc.font('Helvetica-Bold').fontSize(22).fillColor('#0a2540').text('Tax Invoice');
  doc.fillColor('#000');
  doc.moveDown(0.6);

  const blockTop = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).text('To');
  doc.moveDown(0.15);
  doc.font('Helvetica-Bold').fontSize(10).text(customer ? customer.name : '');
  doc.font('Helvetica').fontSize(9.5).fillColor('#333');
  if (job.siteAddress) doc.text(job.siteAddress);
  if (customer && customer.email) doc.text(customer.email);
  doc.fillColor('#000');

  doc.font('Helvetica').fontSize(9.5)
    .text(fmtDate(invoice.dates && invoice.dates.created), M, blockTop, { width: W, align: 'right' });
  doc.text('Invoice No: ' + (invoice.invoiceNumber || invoice.id), { width: W, align: 'right' });
  if (invoice.quoteNumber) doc.text('Re: Quote ' + invoice.quoteNumber, { width: W, align: 'right' });
  if (invoice.dueDate) doc.text('Due Date: ' + fmtDate(invoice.dueDate), { width: W, align: 'right' });
  doc.x = M;
  doc.y = Math.max(doc.y, blockTop + 70);
  doc.moveDown(1);

  const colAmountW = 100, colDescW = W - colAmountW - 10;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#0a2540');
  doc.text('Description', M, doc.y, { width: colDescW });
  doc.text('Amount', M + colDescW + 10, doc.y - doc.currentLineHeight(), { width: colAmountW, align: 'right' });
  doc.fillColor('#000');
  doc.moveDown(0.3);
  doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor('#0a2540').lineWidth(0.75).stroke();
  doc.moveDown(0.4);

  const rowTop = doc.y;
  doc.font('Helvetica-Bold').fontSize(9.5).text((invoice.stageLabel || '').toUpperCase() + ' - ' + invoice.percent + '%', M, rowTop, { width: colDescW });
  doc.font('Helvetica').fontSize(9).fillColor('#333')
    .text('Re: ' + (job.title || job.id) + (job.siteAddress ? ', ' + job.siteAddress : '') +
      '. ' + invoice.percent + '% of the accepted quote total (' + (invoice.quoteNumber || '') + ', ' + money(invoice.quoteTotal) + ' incl GST).',
      M, doc.y, { width: colDescW, lineGap: 1.5 });
  if (invoice.notes) {
    doc.text(invoice.notes, M, doc.y, { width: colDescW, lineGap: 1.5 });
  }
  doc.fillColor('#000');
  const descBottom = doc.y;
  doc.font('Helvetica').fontSize(9.5).text(money(invoice.total), M + colDescW + 10, rowTop, { width: colAmountW, align: 'right' });
  doc.x = M;
  doc.y = descBottom;
  doc.moveDown(0.4);
  doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke();
  doc.moveDown(0.4);

  doc.font('Helvetica').fontSize(9.5);
  doc.text('Subtotal', M, doc.y, { width: colDescW });
  doc.text(money(invoice.subtotal), M + colDescW + 10, doc.y - doc.currentLineHeight(), { width: colAmountW, align: 'right' });
  doc.text('GST 10%', M, doc.y, { width: colDescW });
  doc.text(money(invoice.gst), M + colDescW + 10, doc.y - doc.currentLineHeight(), { width: colAmountW, align: 'right' });
  doc.x = M;
  doc.moveDown(0.3);
  doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor('#0a2540').lineWidth(0.75).stroke();
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0a2540');
  doc.text('Amount Due', M, doc.y, { width: colDescW });
  doc.text('AUD ' + money(invoice.total).replace('$', ''), M + colDescW + 10, doc.y - doc.currentLineHeight(), { width: colAmountW, align: 'right' });
  doc.fillColor('#000');

  ensureSpace(doc, 140);
  doc.moveDown(1);
  doc.x = M;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0a2540').text('Payment Details', M, doc.y, { width: W, align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(0.3);
  doc.x = M;
  if (biz.bankAccountName) {
    doc.font('Helvetica').fontSize(8.5).text('Bank Details: Acc Name: ' + biz.bankAccountName +
      (biz.bankBSB ? '  |  BSB: ' + biz.bankBSB : '') +
      (biz.bankAccountNumber ? '  |  ACC No: ' + biz.bankAccountNumber : ''), M, doc.y, { width: W, align: 'center' });
  }
  doc.moveDown(0.6);
  doc.x = M;
  doc.fontSize(8).fillColor('#555')
    .text(biz.legalNotesDefault || '', M, doc.y, { width: W, align: 'center', lineGap: 2 });
  doc.fillColor('#000');

  withFooters(doc);
  doc.end();
}

// ---- Contractor spec PDF ----------------------------------------------------
// Returns a Buffer so the server can staple attachments (manufacturer spec
// docs, uploaded plans) onto the end before sending.

async function specPdfBuffer(spec, job, customer, survey) {
  // fetch every image up front (they may live in cloud storage)
  const filestore = require('./filestore');
  const photos = ((survey && survey.photos) || []).filter(p => (spec.photoIds || []).includes(p.id));
  const wanted = [];
  for (const p of photos) {
    const file = p.annotatedFile || p.file;
    if (file) wanted.push({ file, caption: (p.caption || 'Site photo') + (p.annotatedFile ? ' (marked up)' : '') });
  }
  if (spec.includeSketch && survey && survey.sketch && survey.sketch.file) {
    wanted.push({ file: survey.sketch.file, caption: 'Site sketch (not to scale)' });
  }
  const images = [];
  for (const img of wanted) {
    const buf = await filestore.read('uploads', path.basename(img.file));
    if (buf) images.push({ buffer: buf, caption: img.caption });
  }
  return new Promise(resolve => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    buildSpecDoc(doc, spec, job, customer, survey, images);
  });
}

function buildSpecDoc(doc, spec, job, customer, survey, images) {
  letterhead(doc);
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#0a2540')
    .text('Work Spec - ' + (spec.tradeLabel || spec.trade));
  doc.fillColor('#000').font('Helvetica').fontSize(9.5).fillColor('#444')
    .text('Job: ' + (job.title || job.id) + '  |  Issued ' + fmtDate(new Date().toISOString()));
  doc.fillColor('#000');
  doc.moveDown(0.6);

  kv(doc, 'Site address', job.siteAddress || (customer && customer.address) || '');
  kv(doc, 'Customer on site', customer ? (customer.name + (customer.phone ? ' - ' + customer.phone : '')) : '');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#B00')
    .text('Read the whole sheet before you start. If anything here does not match the site, stop and call before doing the work.');
  doc.fillColor('#000');

  sectionTitle(doc, 'Your scope on this job');
  doc.text(spec.scope || '', { lineGap: 2 });

  sectionTitle(doc, 'Position');
  doc.text(spec.position || '', { lineGap: 2 });

  sectionTitle(doc, 'Dimensions and levels');
  doc.text(spec.dimensions || '', { lineGap: 2 });

  const m = (survey && survey.measurements) || {};
  if ((m.distances || []).length) {
    doc.moveDown(0.3);
    for (const d of m.distances) {
      doc.text('- ' + d.metres + ' m to ' + d.label);
    }
  }

  sectionTitle(doc, 'Materials - who supplies what');
  for (const mt of spec.materials || []) {
    doc.text('- ' + mt.item + '  >>  ' + mt.suppliedBy);
  }
  if (!(spec.materials || []).length) doc.text('-');

  sectionTitle(doc, 'Site access');
  doc.text(spec.accessNotes || '', { lineGap: 2 });

  sectionTitle(doc, 'Hazards');
  doc.text(spec.hazards || '', { lineGap: 2 });

  sectionTitle(doc, 'Confirm these before you start');
  (spec.questions || []).forEach((q, i) => doc.text((i + 1) + '. ' + q, { lineGap: 2 }));

  withFooters(doc);

  // Photos and sketch on following pages (buffers pre-fetched by specPdfBuffer).
  for (const img of images || []) {
    try {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).text(img.caption);
      doc.moveDown(0.5);
      doc.image(img.buffer, M, doc.y, { fit: [W, 600] });
    } catch (e) { /* unreadable image - skip rather than break the PDF */ }
  }
  doc.end();
}

module.exports = { quotePdf, invoicePdf, specPdfBuffer };
