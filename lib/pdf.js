// PDF output for quotes and contractor spec sheets. Uses pdfkit (pure JS, no
// browser needed). Plain layout, no decoration - these get read on a phone in
// a ute.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const storage = require('./storage');
const { quoteTotals } = require('./prefill');

const M = 50; // page margin
const W = 595.28 - M * 2; // A4 usable width

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function newDoc(res, filename) {
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
  doc.pipe(res);
  return doc;
}

function header(doc, title, subtitle) {
  const biz = storage.getConfig('business.json', {});
  doc.font('Helvetica-Bold').fontSize(16).text(biz.businessName || 'Your Business Name');
  doc.font('Helvetica').fontSize(9).fillColor('#444')
    .text([biz.address, biz.phone, biz.email].filter(Boolean).join('  |  '))
    .text(['ABN ' + (biz.abn || 'XXXXX'), 'Pool Builder Licence ' + (biz.licenceNo || 'XXXXX')].join('  |  '));
  doc.moveDown(0.8);
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(14).text(title);
  if (subtitle) doc.font('Helvetica').fontSize(10).fillColor('#444').text(subtitle);
  doc.fillColor('#000');
  rule(doc);
  return biz;
}

function rule(doc) {
  doc.moveDown(0.4);
  doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor('#999').lineWidth(0.5).stroke();
  doc.moveDown(0.4);
}

function sectionTitle(doc, text) {
  ensureSpace(doc, 60);
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(11).text(text.toUpperCase());
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10);
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > 841.89 - M) doc.addPage();
}

function kv(doc, label, value) {
  doc.font('Helvetica-Bold').fontSize(10).text(label + ': ', { continued: true });
  doc.font('Helvetica').text(value || '-');
}

// ---- Quote PDF --------------------------------------------------------------

function quotePdf(res, quote, job, customer) {
  const doc = newDoc(res, 'quote-' + quote.id + '.pdf');
  const biz = header(doc, 'QUOTE', 'Quote ' + quote.id.replace('quote_', '').toUpperCase() +
    '  |  ' + fmtDate(quote.dates && quote.dates.created));

  kv(doc, 'Customer', customer ? customer.name : '');
  kv(doc, 'Site address', job.siteAddress || (customer && customer.address) || '');
  kv(doc, 'Job', job.title || '');

  sectionTitle(doc, 'What this quote covers');
  doc.text(quote.scopeDescription || '', { lineGap: 2 });

  const totals = quoteTotals(quote);

  if (quote.displayMode === 'lumpSum') {
    sectionTitle(doc, 'Price');
    doc.font('Helvetica').fontSize(10)
      .text('Total for the work described above (ex GST): ' + money(totals.exGst));
    doc.text('GST (10%): ' + money(totals.gst));
    doc.font('Helvetica-Bold').fontSize(12).text('Total including GST: ' + money(totals.total));
  } else {
    sectionTitle(doc, 'Itemised pricing (ex GST)');
    const colDesc = M, colQty = M + 330, colPrice = M + 395, colTotal = M + 465;
    doc.font('Helvetica-Bold').fontSize(9);
    const yh = doc.y;
    doc.text('Item', colDesc, yh, { width: 320 });
    doc.text('Qty', colQty, yh, { width: 60 });
    doc.text('Unit price', colPrice, yh, { width: 65 });
    doc.text('Total', colTotal, yh, { width: 70, align: 'right' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9);
    for (const li of quote.lineItems || []) {
      if (li.included === false) continue;
      ensureSpace(doc, 30);
      const y = doc.y;
      const lineTotal = (parseFloat(li.qty) || 0) * (parseFloat(li.unitPrice) || 0);
      doc.text(li.description, colDesc, y, { width: 320 });
      const yAfter = doc.y;
      doc.text(String(li.qty) + (li.unit && li.unit !== 'each' ? ' ' + li.unit : ''), colQty, y, { width: 60 });
      doc.text(money(li.unitPrice), colPrice, y, { width: 65 });
      doc.text(money(lineTotal), colTotal, y, { width: 70, align: 'right' });
      doc.y = Math.max(yAfter, doc.y);
      doc.moveDown(0.15);
    }
    doc.x = M;
    rule(doc);
    doc.font('Helvetica').fontSize(10);
    if (totals.margin > 0) {
      doc.text('Works subtotal: ' + money(totals.subtotal), { align: 'right' });
      doc.text('Project management and coordination: ' + money(totals.margin), { align: 'right' });
    }
    doc.text('Subtotal (ex GST): ' + money(totals.exGst), { align: 'right' });
    doc.text('GST (10%): ' + money(totals.gst), { align: 'right' });
    doc.font('Helvetica-Bold').fontSize(12).text('Total including GST: ' + money(totals.total), { align: 'right' });
  }

  doc.x = M;
  sectionTitle(doc, 'Terms');
  doc.text('This quote is valid for ' + (quote.validityDays || 30) + ' days from the date above.');
  doc.moveDown(0.3);
  doc.text('Payment terms: ' + (quote.paymentTerms || ''), { lineGap: 2 });
  doc.moveDown(1);
  doc.fontSize(9).fillColor('#444')
    .text('To accept this quote, reply by email or phone ' + (biz.phone || '') + '. ' +
      'Anything not listed above is not included.');
  doc.end();
}

// ---- Contractor spec PDF ----------------------------------------------------
// Returns a Buffer so the server can staple attachments (manufacturer spec
// docs, uploaded plans) onto the end before sending.

function specPdfBuffer(spec, job, customer, survey) {
  return new Promise(resolve => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    buildSpecDoc(doc, spec, job, customer, survey);
  });
}

function buildSpecDoc(doc, spec, job, customer, survey) {
  header(doc, 'WORK SPEC - ' + (spec.tradeLabel || spec.trade).toUpperCase(),
    'Job: ' + (job.title || job.id) + '  |  Issued ' + fmtDate(new Date().toISOString()));

  kv(doc, 'Site address', job.siteAddress || (customer && customer.address) || '');
  kv(doc, 'Customer on site', customer ? (customer.name + (customer.phone ? ' - ' + customer.phone : '')) : '');
  doc.moveDown(0.2);
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

  // Photos and sketch on following pages.
  const photos = ((survey && survey.photos) || []).filter(p => (spec.photoIds || []).includes(p.id));
  const images = [];
  for (const p of photos) {
    const file = p.annotatedFile || p.file;
    if (file) images.push({ file, caption: (p.caption || 'Site photo') + (p.annotatedFile ? ' (marked up)' : '') });
  }
  if (spec.includeSketch && survey && survey.sketch && survey.sketch.file) {
    images.push({ file: survey.sketch.file, caption: 'Site sketch (not to scale)' });
  }
  for (const img of images) {
    const full = path.join(storage.uploadsDir, path.basename(img.file));
    if (!fs.existsSync(full)) continue;
    try {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).text(img.caption);
      doc.moveDown(0.5);
      doc.image(full, M, doc.y, { fit: [W, 600] });
    } catch (e) { /* unreadable image - skip rather than break the PDF */ }
  }
  doc.end();
}

module.exports = { quotePdf, specPdfBuffer };
