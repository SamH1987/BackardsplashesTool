// Builds a contractor spec sheet for one trade from the accepted quote and
// the site survey. The goal: the contractor never has to ring the founder to
// ask "where does it go" or "who's supplying the sand".

const { excavationCalc, slabCalc } = require('./prefill');

const TRADE_QUESTIONS = {
  concrete: [
    'Confirm slab set-down height against finished ground level before pouring.',
    'Confirm concrete truck access or whether a pump is needed.',
    'Any reinforcement or engineering requirements beyond standard mesh?'
  ],
  plumbing: [
    'Confirm tie-in point for drainage before digging.',
    'Confirm pipe route shown on the sketch is clear of other services.',
    'Is a backflow device required at this property?'
  ],
  electrical: [
    'Confirm spare capacity on the switchboard for a dedicated circuit.',
    'Confirm isolator position with the customer before mounting.',
    'Does the run require trenching or can it follow the fence line?'
  ],
  excavation: [
    'Confirm dial-before-you-dig check is done before machinery arrives.',
    'Confirm spoil removal - staying on site or being carted away?'
  ],
  crane: [
    'Confirm street access and any council permit needs for the lift.',
    'Confirm overhead clearance - check for power lines on the lift path.'
  ],
  general: [
    'Confirm start date and site access arrangements with the customer.'
  ]
};

function tradeLabel(trade) {
  const labels = {
    concrete: 'Concrete', plumbing: 'Plumbing', electrical: 'Electrical',
    excavation: 'Excavation', crane: 'Crane / lift', general: 'General works'
  };
  return labels[trade] || trade;
}

function buildSpec(trade, job, survey, quote, newId) {
  const s = survey || {};
  const m = s.measurements || {};
  const spa = m.spa || {};
  const c = s.conditions || {};
  const notes = (s.video && s.video.structuredNotes) || {};

  // Scope: only this trade's line items, in plain words.
  const tradeItems = (quote.lineItems || []).filter(li => li.included !== false && li.trade === trade);
  const scopeLines = tradeItems.map(li => {
    let line = '- ' + li.description;
    if (li.unit && li.unit !== 'each' && li.qty) line += ' (' + li.qty + ' ' + li.unit + ')';
    if (li.notes) line += '. ' + li.notes;
    return line;
  });

  // Position, stated explicitly - never "as discussed".
  const positionParts = [];
  if (notes.position && notes.position.length) positionParts.push(notes.position.join(' '));
  for (const d of m.distances || []) {
    if (d.label && d.metres) positionParts.push(d.metres + 'm from ' + d.label + '.');
  }
  const position = positionParts.join(' ') || 'TBC';

  const dimensionParts = [];
  if (spa.lengthM && spa.widthM) {
    dimensionParts.push('Spa: ' + spa.lengthM + 'm long x ' + spa.widthM + 'm wide' +
      (spa.depthM ? ' x ' + spa.depthM + 'm deep' : '') +
      (spa.weightKg ? ', approx ' + spa.weightKg + 'kg dry' : '') + '.');
  }
  const exc = excavationCalc(s);
  if (exc && (trade === 'excavation' || trade === 'concrete')) {
    dimensionParts.push('Excavation: ' + exc.lengthM + 'm long x ' + exc.widthM + 'm wide x ' +
      exc.depthM + 'm deep = ' + exc.volumeM3 + ' m3 of spoil (~' + exc.tonnes + ' t), allow ' +
      exc.loadsAllow + ' bogie truck load' + (exc.loadsAllow === 1 ? '' : 's') + '.');
  }
  const slab = slabCalc(s);
  if (slab && trade === 'concrete') {
    dimensionParts.push('Slab: ' + slab.lengthM + 'm x ' + slab.widthM + 'm = ' + slab.areaM2 + ' m2' +
      (slab.volumeM3 ? ', ' + slab.depthM + 'm thick = ' + slab.volumeM3 + ' m3 of concrete' : '') + '.');
  }
  const walls = (m.retainingWalls || []).filter(w => parseFloat(w.lengthM));
  if (walls.length && (trade === 'concrete' || trade === 'excavation' || trade === 'general')) {
    for (const w of walls) {
      dimensionParts.push('Retaining wall (' + (w.type || 'type TBC') + '): ' + w.lengthM + 'm long x ' +
        (w.heightM || '?') + 'm high' + (w.thicknessM ? ' x ' + w.thicknessM + 'm thick' : '') +
        (parseFloat(w.lengthM) && parseFloat(w.heightM)
          ? ' = ' + Math.round(parseFloat(w.lengthM) * parseFloat(w.heightM) * 10) / 10 + ' m2 face'
          : '') + '.');
    }
  }
  const deck = m.decking || {};
  if (parseFloat(deck.lengthM) && parseFloat(deck.widthM) && (trade === 'general' || trade === 'concrete')) {
    const placeLabels = { front: 'in front of the spa', around: 'wrapped all around the spa', left: 'left of the spa', right: 'right of the spa', behind: 'behind the spa' };
    dimensionParts.push('Decking: ' + deck.lengthM + 'm x ' + deck.widthM + 'm = ' +
      Math.round(parseFloat(deck.lengthM) * parseFloat(deck.widthM) * 10) / 10 + ' m2, ' +
      (placeLabels[deck.placement] || placeLabels.front) +
      (deck.brand ? ', ' + deck.brand : '') + '.');
  }
  const plumb = m.plumbing || {};
  if (trade === 'plumbing' && (plumb.drainagePitRequired || (plumb.notes || '').trim())) {
    dimensionParts.push((plumb.drainagePitRequired ? 'External drainage pit required.' : '') +
      ((plumb.notes || '').trim() ? ' ' + plumb.notes.trim() : ''));
  }
  const elec = m.electrical || {};
  if (trade === 'electrical' && (elec.supplyAmps || elec.runM)) {
    dimensionParts.push('Electrical: ' + (elec.supplyAmps ? elec.supplyAmps + ' supply' : 'supply size TBC') +
      (elec.runM ? ', cable run approx ' + elec.runM + ' m' : '') + '.');
  }
  if (m.stepLevelChanges) dimensionParts.push('Levels: ' + m.stepLevelChanges);
  const dimensions = dimensionParts.join(' ') || 'TBC';

  // Access + hazards.
  const accessParts = [];
  if (m.accessWidthM) accessParts.push('Access path is ' + m.accessWidthM + 'm wide.');
  if (c.machineryNotes) accessParts.push(c.machineryNotes);
  if (notes.access && notes.access.length) accessParts.push(notes.access.join(' '));
  const accessNotes = accessParts.join(' ') || 'TBC';

  const hazardParts = [];
  if (c.visibleUtilities) hazardParts.push('Visible services on site: ' + c.visibleUtilities + '.');
  if (c.obstacles) hazardParts.push('Obstacles: ' + c.obstacles + '.');
  if (notes.hazards && notes.hazards.length) hazardParts.push(notes.hazards.join(' '));
  const hazards = hazardParts.join(' ') || 'None noted on survey.';

  // Materials: from the quote's supplier field for this trade.
  const materials = tradeItems.map(li => ({
    item: li.description,
    suppliedBy: li.supplier === 'contractor' ? 'Contractor supplies' :
                li.supplier === 'customer' ? 'Customer supplies' : 'We supply'
  }));

  return {
    id: newId('spec'),
    jobId: job.id,
    quoteId: quote.id,
    trade,
    tradeLabel: tradeLabel(trade),
    status: 'draft',
    scope: scopeLines.join('\n') || 'TBC',
    position,
    dimensions,
    accessNotes,
    hazards,
    materials,
    questions: (TRADE_QUESTIONS[trade] || TRADE_QUESTIONS.general).slice(),
    photoIds: (s.photos || []).map(p => p.id),
    includeSketch: !!(s.sketch && s.sketch.file),
    // the manufacturer's spec/delivery doc rides along for the trades that need it
    includeSpaDoc: trade === 'electrical' || trade === 'crane',
    attachDocs: [],
    checkResults: null,
    createdAt: new Date().toISOString()
  };
}

module.exports = { buildSpec, tradeLabel, TRADE_QUESTIONS };
