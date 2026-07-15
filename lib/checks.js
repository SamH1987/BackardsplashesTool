// Self-check pass. The list of checks lives in config/checklists/*.json so the
// founder can switch checks off, reword them, or add his own. Checks with a
// known id run automatically against the data. Checks with an unknown id (ones
// the founder adds himself) show up as manual tick-boxes before send.

const storage = require('./storage');
const { quoteTotals, slabAreaM2, TIGHT_ACCESS_M } = require('./prefill');

function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

// ---- Quote checks -----------------------------------------------------------

const QUOTE_CHECKS = {
  no_zero_line_items(quote) {
    const bad = (quote.lineItems || []).filter(li => li.included !== false && num(li.unitPrice) <= 0);
    return bad.length
      ? fail('These line items are still at $0: ' + bad.map(li => li.description).join('; '))
      : pass();
  },
  crane_priced_if_needed(quote, ctx) {
    const craneNeeded = !!(ctx.survey && ctx.survey.conditions && ctx.survey.conditions.craneNeeded);
    if (!craneNeeded) return pass('Survey says no crane needed.');
    const craneItem = (quote.lineItems || []).find(li =>
      li.included !== false && (li.trade === 'crane' || /crane/i.test(li.description)) && num(li.unitPrice) > 0);
    return craneItem ? pass() : fail('Survey says crane is needed but no priced crane item is in the quote.');
  },
  slab_sized_from_survey(quote, ctx) {
    const area = slabAreaM2(ctx.survey);
    if (!area) return fail('Spa length/width missing from the survey, so slab size cannot be confirmed.');
    const slabItem = (quote.lineItems || []).find(li =>
      li.included !== false && /slab|concrete pad|base/i.test(li.description));
    if (!slabItem) return fail('No slab / base line item found in the quote.');
    if (slabItem.unit === 'm2' && Math.abs(num(slabItem.qty) - area) > area * 0.5) {
      return fail('Slab is quoted at ' + slabItem.qty + ' m2 but survey suggests about ' + area + ' m2. Check it.');
    }
    return pass();
  },
  access_priced_if_tight(quote, ctx) {
    const w = num(ctx.survey && ctx.survey.measurements && ctx.survey.measurements.accessWidthM);
    if (!w) return fail('Access width was not recorded in the survey.');
    if (w >= TIGHT_ACCESS_M) return pass('Access is ' + w + 'm wide - no surcharge needed.');
    const item = (quote.lineItems || []).find(li =>
      li.included !== false && /access|manual handl|carry/i.test(li.description) && num(li.unitPrice) > 0);
    return item ? pass() : fail('Access is only ' + w + 'm wide but nothing is priced for tight access / manual handling.');
  },
  measurements_accounted(quote, ctx) {
    const m = (ctx.survey && ctx.survey.measurements) || {};
    const missing = [];
    if (!(m.spa && m.spa.lengthM && m.spa.widthM)) missing.push('spa dimensions');
    if (!m.accessWidthM) missing.push('access width');
    if (!(m.distances && m.distances.length)) missing.push('distances to boundaries/services');
    return missing.length
      ? fail('The survey is missing: ' + missing.join(', ') + '. Fill these in before quoting.')
      : pass();
  },
  scope_matches_survey(quote, ctx) {
    const scope = (quote.scopeDescription || '').toLowerCase();
    if (!scope.trim()) return fail('The quote has no scope description.');
    const problems = [];
    const c = (ctx.survey && ctx.survey.conditions) || {};
    if (c.craneNeeded && !scope.includes('crane')) problems.push('survey says crane needed but scope never mentions a crane');
    const spa = (ctx.survey && ctx.survey.measurements && ctx.survey.measurements.spa) || {};
    if (spa.lengthM && !scope.includes(String(spa.lengthM))) problems.push('spa dimensions from the survey do not appear in the scope');
    return problems.length ? fail('Scope may not match the survey: ' + problems.join('; ') + '.') : pass();
  },
  validity_and_terms_set(quote) {
    const problems = [];
    if (!num(quote.validityDays)) problems.push('no validity period');
    if (!(quote.paymentTerms || '').trim()) problems.push('no payment terms');
    return problems.length ? fail('Quote has ' + problems.join(' and ') + '.') : pass();
  },
  business_details_set() {
    const biz = storage.getConfig('business.json', {});
    const placeholderish = ['your business name', 'xxxxx', ''];
    const bad = [];
    if (placeholderish.includes((biz.businessName || '').toLowerCase())) bad.push('business name');
    if (placeholderish.includes((biz.licenceNo || '').toLowerCase())) bad.push('licence number');
    return bad.length
      ? fail('Settings still has placeholder ' + bad.join(' and ') + '. Fix it in Settings before sending anything.')
      : pass();
  }
};

// ---- Spec checks ------------------------------------------------------------

const SPEC_CHECKS = {
  position_stated(spec) {
    return isTbc(spec.position) ? fail('Position is blank or still says TBC. State exactly where the spa sits.') : pass();
  },
  dimensions_stated(spec) {
    return isTbc(spec.dimensions) ? fail('Dimensions are blank or still say TBC.') : pass();
  },
  photos_attached(spec) {
    return (spec.photoIds || []).length ? pass() : fail('No site photos attached to this spec.');
  },
  materials_responsibility(spec) {
    if (!(spec.materials || []).length) return fail('Materials list is empty - state who supplies what.');
    const bad = spec.materials.filter(mt => !mt.suppliedBy || isTbc(mt.suppliedBy));
    return bad.length ? fail('These materials have no supplier stated: ' + bad.map(mt => mt.item).join('; ')) : pass();
  },
  no_tbc_fields(spec) {
    const fields = { scope: spec.scope, position: spec.position, dimensions: spec.dimensions, 'access notes': spec.accessNotes };
    const bad = Object.keys(fields).filter(k => /\bTBC\b/i.test(fields[k] || '') || !(fields[k] || '').trim());
    return bad.length ? fail('These fields are blank or contain TBC: ' + bad.join(', ') + '.') : pass();
  },
  access_notes_present(spec) {
    return isTbc(spec.accessNotes) ? fail('No site access notes. The contractor needs to know how to get gear in.') : pass();
  },
  questions_listed(spec) {
    return (spec.questions || []).filter(q => (q || '').trim()).length
      ? pass()
      : fail('No "questions to confirm before starting" listed.');
  }
};

function isTbc(v) { return !(v || '').trim() || /\bTBC\b/i.test(v || ''); }
function pass(note) { return { ok: true, note: note || '' }; }
function fail(note) { return { ok: false, note }; }

// Runs a checklist file against a record. Returns per-check results.
function runChecks(kind, record, ctx) {
  const file = kind === 'quote' ? 'checklists/quote.json' : 'checklists/spec.json';
  const registry = kind === 'quote' ? QUOTE_CHECKS : SPEC_CHECKS;
  const checklist = storage.getConfig(file, []);
  const results = [];
  for (const check of checklist) {
    if (check.enabled === false) continue;
    const fn = registry[check.id];
    if (fn) {
      let r;
      try { r = fn(record, ctx || {}); }
      catch (e) { r = fail('Check could not run: ' + e.message); }
      results.push({ id: check.id, label: check.label, type: 'auto', ok: r.ok, note: r.note });
    } else {
      // Founder-added check with no code behind it: manual tick-box.
      const ticked = !!(record.manualChecks && record.manualChecks[check.id]);
      results.push({ id: check.id, label: check.label, type: 'manual', ok: ticked, note: ticked ? 'Ticked off manually.' : 'Tick this off yourself before sending.' });
    }
  }
  const failures = results.filter(r => !r.ok);
  return { ranAt: new Date().toISOString(), allPassed: failures.length === 0, results };
}

module.exports = { runChecks };
