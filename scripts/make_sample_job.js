// Builds the sample training job: Mitchell in-ground spa at Baulkham Hills.
// Uses the same library code as the app, so the pre-filled quote and the
// contractor specs are exactly what the system produces for real jobs.
// Safe to re-run: it rebuilds the sample records from scratch.
// Run with: runtime/bin/node scripts/make_sample_job.js

const storage = require('../lib/storage');
const { prefillLineItems, buildScopeDescription } = require('../lib/prefill');
const { buildSpec } = require('../lib/specgen');
const { structureNotes } = require('../lib/transcribe');

function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }
function inDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

// ---- customer ----
const customer = {
  id: 'cust_sample',
  name: 'Karen & David Mitchell',
  phone: '0412 555 210',
  email: 'kdmitchell@example.com',
  address: '14 Waratah St, Baulkham Hills NSW 2153',
  notes: 'Found us through the spa dealer. Karen is the main contact, works from home most days. Dog on site (friendly) - keep the side gate shut.',
  externalRefs: { xero: null, googleDrive: null, uconnect: null },
  createdAt: daysAgo(27)
};
storage.customers.save(customer);

// ---- survey ----
const transcript = 'Righto, standing at the side gate looking down the path. Gate opening is one point zero five metres so it is tight, the shell will need to come over the house by crane. One step down at the gate then flat all the way to the back. Spa is going in the back left corner, one point eight metres off the rear boundary and one point two off the left side fence, so the equipment hatch faces the house. Shell is two point three by two point three, nine fifty kilos dry. Ground is clay under the lawn, slight fall towards the back fence. There is a lemon tree right where it goes, David said he will pull that out himself before we start. Water tap on the rear wall of the house about six metres away, sewer point is near the laundry, call it eight metres. Switchboard is on the garage side, about eighteen metres of cable run along the fence line. Overhead power comes in over the front yard, nothing over the back, so the crane lift path is clear. Karen wants the spa sitting flush with a deck they are building later, and they asked us to keep the concrete as small as we can. Budget they mentioned is around twenty five grand all in.';

const survey = {
  completedBy: 'Sam',
  date: daysAgo(15).slice(0, 10),
  photos: [
    { id: 'photo_sample1', file: 'sample_photo_backyard.png', annotatedFile: 'sample_photo_backyard_annotated.png', caption: 'Back yard from the gate - red box is the spa position, arrow is the access route' },
    { id: 'photo_sample2', file: 'sample_photo_access.png', annotatedFile: 'sample_photo_access_annotated.png', caption: 'Side path - narrowest point 1.05m at the gate' },
    { id: 'photo_sample3', file: 'sample_photo_switchboard.png', annotatedFile: null, caption: 'Switchboard on garage wall - 18m cable run to spa position' }
  ],
  video: {
    file: null, // sample job ships without the actual video file
    transcript,
    structuredNotes: structureNotes(transcript)
  },
  sketch: { file: 'sample_sketch.png' },
  measurements: {
    spa: { lengthM: '2.3', widthM: '2.3', depthM: '0.95', weightKg: '950' },
    // excavation and slab stay blank - the founder types these on site, never pre-filled
    excavation: { lengthM: '', widthM: '', depthM: '' },
    slab: { lengthM: '', widthM: '', depthM: '' },
    retainingWalls: [],
    decking: { lengthM: '', widthM: '', brand: '' },
    plumbing: { drainagePitRequired: true, notes: 'Pit to tie into existing stormwater near the laundry sewer point' },
    electrical: { supplyAmps: '32 A', runM: '18' },
    distances: [
      { label: 'rear boundary', metres: '1.8' },
      { label: 'side boundary (left)', metres: '1.2' },
      { label: 'house wall', metres: '4.5' },
      { label: 'switchboard', metres: '18' },
      { label: 'water tap', metres: '6' },
      { label: 'sewer point', metres: '8' }
    ],
    accessWidthM: '1.05',
    stepLevelChanges: 'One step down at the side gate, then flat to the back corner'
  },
  conditions: {
    groundType: 'clay',
    slope: 'slight fall',
    obstacles: 'Lemon tree on the spa position - owner is removing it before work starts',
    visibleUtilities: 'Water tap on rear wall, sewer point near laundry, overhead power over FRONT yard only - back yard clear for the lift',
    craneNeeded: true,
    machineryNotes: 'Crane sets up on the street and lifts the shell over the house. Lift path over the back yard is clear of wires. Council parking permit may be needed for the crane - check.'
  },
  wishlist: 'Spa to sit flush with a future deck (deck by others, later). Keep the concrete apron as small as possible. Isolator switch out of sight from the outdoor table if it can be done.',
  budgetIndication: 'Around $25,000 all in'
};

// ---- job ----
const job = {
  id: 'job_sample',
  customerId: customer.id,
  title: 'In-ground spa, back corner',
  siteAddress: customer.address,
  installType: 'in-ground spa',
  approvalStatus: 'approved',
  stage: 'contractors_booked',
  stageHistory: [
    { stage: 'lead', date: daysAgo(27) },
    { stage: 'survey_done', date: daysAgo(15) },
    { stage: 'quote_sent', date: daysAgo(12) },
    { stage: 'accepted', date: daysAgo(7) },
    { stage: 'contractors_booked', date: daysAgo(3) }
  ],
  responsible: 'Sam',
  nextAction: { text: 'Confirm electrician rough-in day and tell Karen which morning the crane comes', due: inDays(1), who: 'Sam' },
  survey,
  documents: [],
  updatesLog: [
    { date: daysAgo(6), message: 'Hi Karen, great news - your job is locked in. We are lining up the trades now and will confirm start dates with you shortly. Sam' }
  ],
  createdAt: daysAgo(27)
};
storage.jobs.save(job);

// ---- quote (from the in-ground template, pre-filled from the survey) ----
const template = storage.templates.get('tmpl_in_ground');
const quote = {
  id: 'quote_sample',
  jobId: job.id,
  templateId: template.id,
  templateName: template.name,
  status: 'accepted',
  dates: { created: daysAgo(13), sent: daysAgo(12), accepted: daysAgo(7), declined: null },
  scopeDescription: buildScopeDescription(job, survey, template),
  lineItems: prefillLineItems(template, survey),
  marginPercent: 15,
  displayMode: 'itemised',
  validityDays: 30,
  paymentTerms: '10% deposit on acceptance. 40% before work starts on site. 40% when the spa is placed. Final 10% on handover. Payment by bank transfer within 3 days of each invoice.',
  manualChecks: {},
  checkResults: null,
  createdAt: daysAgo(13)
};
storage.quotes.save(quote);

// ---- contractor specs: concrete, plumbing, electrical ----
// Same generator the "Generate specs" button uses.
for (const existing of storage.specs.list()) {
  if (existing.jobId === job.id) storage.specs.remove(existing.id);
}
const fixedIds = { concrete: 'spec_sample_concrete', plumbing: 'spec_sample_plumbing', electrical: 'spec_sample_electrical' };
for (const trade of ['concrete', 'plumbing', 'electrical']) {
  const spec = buildSpec(trade, job, survey, quote, () => fixedIds[trade]);
  spec.status = 'final';
  spec.createdAt = daysAgo(5);
  storage.specs.save(spec);
}

console.log('Sample job ready: Karen & David Mitchell - in-ground spa, Baulkham Hills.');
