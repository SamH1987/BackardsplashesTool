// Turns a site survey into pre-filled quote line items and a plain-English
// scope description. Prices come from the template files in data/templates —
// this file only decides quantities and which items apply.

const SLAB_MARGIN_M = 0.6; // slab extends 300mm past the spa on each side
const TIGHT_ACCESS_M = 1.1; // access narrower than this = manual handling surcharge applies
const BOGIE_TRUCK_M3 = 6.5; // one bogie truck takes 6.5 m3 of spoil (about 12 t in soil)

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// Measured slab size, if the surveyor recorded one. Returns null when not measured.
function slabCalc(survey) {
  const slab = (survey && survey.measurements && survey.measurements.slab) || {};
  const l = num(slab.lengthM), w = num(slab.widthM), d = num(slab.depthM);
  if (!l || !w) return null;
  return {
    lengthM: l, widthM: w, depthM: d,
    areaM2: Math.round(l * w * 10) / 10,
    volumeM3: d ? Math.round(l * w * d * 100) / 100 : null
  };
}

// Slab area for quoting: use the measured slab if there is one, otherwise
// derive it from the spa size plus a 300mm margin each side.
function slabAreaM2(survey) {
  const measured = slabCalc(survey);
  if (measured) return measured.areaM2;
  const spa = (survey && survey.measurements && survey.measurements.spa) || {};
  const l = num(spa.lengthM), w = num(spa.widthM);
  if (!l || !w) return 0;
  return Math.round((l + SLAB_MARGIN_M) * (w + SLAB_MARGIN_M) * 10) / 10;
}

// Dig volume and how many truck loads of spoil to allow for.
function excavationCalc(survey) {
  const ex = (survey && survey.measurements && survey.measurements.excavation) || {};
  const l = num(ex.lengthM), w = num(ex.widthM), d = num(ex.depthM);
  if (!l || !w || !d) return null;
  const volume = l * w * d;
  const loadsExact = volume / BOGIE_TRUCK_M3;
  return {
    lengthM: l, widthM: w, depthM: d,
    volumeM3: Math.round(volume * 10) / 10,
    loadsExact: Math.round(loadsExact * 100) / 100,
    loadsAllow: Math.ceil(loadsExact),
    tonnes: Math.round(volume / BOGIE_TRUCK_M3 * 12 * 10) / 10
  };
}

function excavationNote(exc) {
  return 'Dig from survey: ' + exc.lengthM + 'm x ' + exc.widthM + 'm x ' + exc.depthM +
    'm = ' + exc.volumeM3 + ' m3 of spoil (~' + exc.tonnes + ' t) - allow ' + exc.loadsAllow +
    ' bogie truck load' + (exc.loadsAllow === 1 ? '' : 's') + ' (' + BOGIE_TRUCK_M3 + ' m3 / ~12 t each)';
}

function findDistance(survey, keywords) {
  const list = (survey && survey.measurements && survey.measurements.distances) || [];
  for (const d of list) {
    const label = (d.label || '').toLowerCase();
    if (keywords.some(k => label.includes(k))) return num(d.metres);
  }
  return 0;
}

// Builds quote line items from a template + survey. Each template line item
// can carry a "prefill" key that tells us how to size or include it.
function prefillLineItems(template, survey) {
  const area = slabAreaM2(survey);
  // Electrical run: the dedicated field wins; fall back to the measured
  // distance to the switchboard.
  const elecSection = (survey && survey.measurements && survey.measurements.electrical) || {};
  const elecRun = num(elecSection.runM) || findDistance(survey, ['switchboard', 'power', 'meter']);
  const plumbRun = findDistance(survey, ['water', 'tap', 'sewer', 'drain']);
  const accessWidth = num(survey && survey.measurements && survey.measurements.accessWidthM);
  const craneNeeded = !!(survey && survey.conditions && survey.conditions.craneNeeded);
  const exc = excavationCalc(survey);

  return template.lineItems.map(item => {
    const li = {
      code: item.code,
      description: item.description,
      trade: item.trade || 'general',
      unit: item.unit || 'each',
      qty: item.defaultQty != null ? item.defaultQty : 1,
      unitPrice: item.unitPrice != null ? item.unitPrice : 0,
      supplier: item.supplier || 'us',
      included: true,
      notes: item.notes || '',
      prefillNote: ''
    };
    switch (item.prefill) {
      case 'slab_area':
        if (area > 0) {
          li.qty = area;
          const measured = slabCalc(survey);
          if (measured) {
            li.prefillNote = 'Slab measured on survey: ' + measured.lengthM + 'm x ' + measured.widthM +
              'm = ' + measured.areaM2 + ' m2' +
              (measured.volumeM3 ? ', ' + measured.depthM + 'm thick = ' + measured.volumeM3 + ' m3 of concrete' : '');
          } else {
            li.prefillNote = 'Sized from survey: spa ' +
              survey.measurements.spa.lengthM + 'm x ' + survey.measurements.spa.widthM +
              'm plus 300mm each side = ' + area + ' m2';
          }
        } else {
          li.prefillNote = 'Could not size slab - no slab or spa measurements in survey';
        }
        break;
      case 'crane':
        li.included = craneNeeded;
        li.prefillNote = craneNeeded
          ? 'Survey says crane/machinery access is needed'
          : 'Survey says no crane needed - item left out (tick to include anyway)';
        break;
      case 'electrical_run':
        if (elecRun > 0) {
          li.qty = elecRun;
          li.prefillNote = 'Cable run from survey: ' + elecRun + ' m' +
            (elecSection.supplyAmps ? ' (' + elecSection.supplyAmps + ' supply)' : '');
        } else {
          li.prefillNote = 'No cable run or switchboard distance recorded in survey - check qty';
        }
        break;
      case 'plumbing_run':
        if (plumbRun > 0) {
          li.qty = plumbRun;
          li.prefillNote = 'Distance to water/drainage from survey: ' + plumbRun + ' m';
        } else {
          li.prefillNote = 'No distance to water/drain recorded in survey - check qty';
        }
        break;
      case 'tight_access':
        li.included = accessWidth > 0 && accessWidth < TIGHT_ACCESS_M;
        li.prefillNote = li.included
          ? 'Access is ' + accessWidth + ' m wide (under ' + TIGHT_ACCESS_M + ' m) - manual handling applies'
          : 'Access width ' + (accessWidth || 'not recorded') + ' m - surcharge not applied';
        break;
    }
    // Excavation lines get the dig size and truck loads so pricing covers the spoil.
    if (li.trade === 'excavation' && exc && !li.prefillNote) {
      li.prefillNote = excavationNote(exc);
    }
    return li;
  });
}

// Plain-English scope paragraph a customer can actually read.
function buildScopeDescription(job, survey, template) {
  const parts = [];
  const typeName = (template ? template.name : (job.installType || 'spa installation')).toLowerCase();
  const article = /^[aeiou]/.test(typeName) ? 'an' : 'a';
  parts.push('Supply of installation services for ' + article + ' ' + typeName + ' at ' + (job.siteAddress || 'the site address listed above') + '.');

  const s = survey || {};
  const m = s.measurements || {};
  const spa = m.spa || {};
  if (spa.lengthM && spa.widthM) {
    parts.push('The spa is ' + spa.lengthM + 'm long x ' + spa.widthM + 'm wide' +
      (spa.depthM ? ' x ' + spa.depthM + 'm deep' : '') + '.');
  }
  const notes = (s.video && s.video.structuredNotes) || {};
  if (notes.position && notes.position.length) {
    parts.push('Position: ' + notes.position.join(' '));
  }
  const c = s.conditions || {};
  if (c.craneNeeded) {
    parts.push('A crane will be used to place the spa. Crane hire is included in this quote.');
  }
  if (m.accessWidthM) {
    parts.push('Site access is via a ' + m.accessWidthM + 'm wide path.');
  }
  if (c.groundType) {
    parts.push('Ground conditions: ' + c.groundType + (c.slope ? ', ' + c.slope : '') + '.');
  }
  parts.push('Work covered: ' + (template ? summariseTrades(template) : 'as itemised below') + '.');
  parts.push('The price does not cover anything not listed in this quote.');
  return parts.join(' ');
}

function summariseTrades(template) {
  const names = [];
  const seen = {};
  for (const li of template.lineItems) {
    const t = li.trade || 'general';
    if (!seen[t]) { seen[t] = true; names.push(t); }
  }
  return names.join(', ');
}

function quoteTotals(quote) {
  let subtotal = 0;
  for (const li of quote.lineItems || []) {
    if (li.included === false) continue;
    subtotal += num(li.qty) * num(li.unitPrice);
  }
  const margin = subtotal * (num(quote.marginPercent) / 100);
  const exGst = subtotal + margin;
  const gst = exGst * 0.10;
  return {
    subtotal: round2(subtotal),
    margin: round2(margin),
    exGst: round2(exGst),
    gst: round2(gst),
    total: round2(exGst + gst)
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { prefillLineItems, buildScopeDescription, quoteTotals, slabAreaM2, slabCalc, findDistance, excavationCalc, excavationNote, TIGHT_ACCESS_M, BOGIE_TRUCK_M3 };
