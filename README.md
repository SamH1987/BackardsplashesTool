# Spa Jobs

A site survey, quoting and job management system for a spa and pool installation business.

## What it is

One system that carries a job from first phone call to final invoice. You capture the site once — photos, video walkthrough, sketch, measurements — and everything downstream is built from that: the quote, the spec sheets for each trade, and the job tracker. Nothing gets typed twice, and nothing lives only in someone's head.

## Who uses it

- **Now:** the founder does everything — site visits, quotes, coordination — from a phone on site and a desktop at home.
- **Later:** a hired surveyor does the site visits with the same survey tool, and a project coordinator runs the tracker. Nothing changes about the system; only who is holding the phone. The "who runs this job" and "whose job is it" fields exist for that day.

## How to start it

**Double-click `Start Spa Jobs.command` in this folder.**

The first time, macOS may say it's from an unidentified developer: right-click the file, choose **Open**, then **Open** again. After that it's one double-click.

A browser window opens at `http://localhost:4321`. To use it on your phone while on the same wifi, the start window prints an address like `http://192.168.x.x:4321` — type that into your phone's browser.

Everything runs and is stored on this computer. No accounts, no internet needed after setup (the first video transcription downloads a speech model once, ~150MB).

## Working offline on the phone

Add Spa Jobs to your phone's home screen (open it in Safari on the home wifi → Share → **Add to Home Screen**). From then on it opens like a real app, **with or without a connection**: jobs, surveys and the catalogue you've opened before all load offline, and anything you enter on site — measurements, notes, photos, the sketch — is saved on the phone and **syncs to this computer automatically** the next time the phone can reach it. Open the app once on the home wifi before heading out and it quietly pre-loads every job for the day. The exceptions that still need a connection: video/scan uploads (they stay safely on the phone until you're back), transcription, quotes and PDFs — desk work anyway.

## The workflow, start to finish

1. **New lead.** Add the customer (Customers screen), start a job, book the site visit. Every job has a "next action" that is never allowed to be empty.
2. **Site survey (on site, on your phone).** Pick the customer's spa from the built-in **catalogue** (138 models with photos and sizes from Spa World, Just Spas and Alpine Spas — browse or edit it under Settings) and the spa dimensions fill themselves; the product photo follows the job into the 3D view. Photos — draw on them to mark the spa position, pipe runs and access route. Record a video walkthrough while talking through the site; the system types up what you said and sorts it into position / dimensions / access / hazards / customer requests. Sketch the layout with your finger. Punch in the measurements and tick the site conditions. Save before you leave the driveway.
3. **Quote (at your desk).** Pick a price template (above-ground spa, in-ground spa, swim spa, plunge pool). The system pre-fills quantities from the survey: slab size from the spa dimensions, cable and pipe runs from the measured distances, crane and tight-access items switched on if the survey says so. Adjust, add extras, set your margin. Run the self-check. Download the PDF, send it, mark it sent. The system will not let a quote go out that fails the self-check.
4. **Accepted.** Mark the quote accepted. Generate the contractor spec sheets — one per trade, each containing only that trade's scope, plus the marked-up photos, sketch, measurements, who-supplies-what, access notes, hazards, and a "confirm before starting" list. Run the self-check, finalise, text or email the PDF to each contractor.
5. **Show the customer (optional).** Every job with a survey gets a **3D view** button: a to-scale model of the spa, slab, deck and retaining walls sitting at the measured distances from their fences and house, built automatically from the survey. Works on any phone or computer. With a Meta Quest headset on the same wifi, open the https address the start window prints (accept the certificate warning once), open the job's 3D view, and use **"See it in YOUR yard"** — the customer stands in their backyard and sees the to-scale spa through the headset; pull the trigger to move it around. It is a plain-colours scale model, not a photo-real render — for those, a render company still does that job.
6. **Track it.** The job board shows every stage with dates. "This week" shows what has to be booked, chased or confirmed across all jobs, and flags anything sitting in a stage too long (you set the limits in Settings). One tap writes a plain-English status text for the customer.
7. **Done.** Mark complete, then invoiced. The whole job history stays on file.

## The training example

The system ships with one finished sample job — **Karen & David Mitchell, in-ground spa at Baulkham Hills** — with a completed survey, an accepted quote, and finalised specs for the concrete, plumbing and electrical trades, mid-flight on the tracker. Open it and click around before doing a real one. `HOW_TO.md` is the step-by-step for site surveys.

## Files you are meant to edit

These encode your judgement. Change them from the Settings screen, or open them directly — they are plain text:

| File | What it controls |
|---|---|
| `config/business.json` | Your business details on every PDF, default margin, payment terms |
| `data/templates/*.json` | Base pricing per install type and the standard line items |
| `config/checklists/quote.json` | What gets checked before a quote can be sent |
| `config/checklists/spec.json` | What gets checked before a spec can be finalised |
| `config/tracker.json` | How many days a job can sit in a stage before being flagged |
| `config/update-templates.json` | The customer status messages, one per stage |

**Before your first real quote: open Settings and replace the placeholder business details.** The self-check blocks sending until you do.

## Where your data lives

Everything is plain files inside this folder — `data/customers`, `data/jobs`, `data/quotes`, `data/specs`, `data/uploads` (photos, videos, sketches). Back the whole folder up by copying it. Future connections to Google Drive, Xero and Uconnect are mapped out in `FUTURE_INTEGRATIONS.md`.

## Owner-only costs and profit

Every job has a **Job costs & profit** button that opens a passcode-locked area: type in what each quoted item actually cost you as the job runs (plus any extras), and it shows profit against the quote. The first time you open it you set the passcode — pick something only you know, because there is no reset. Cost data lives in `data/private/`, which no other screen ever reads, so a future surveyor or coordinator using this system never sees your numbers. (Anyone with full access to this computer's files could still open that folder — the passcode protects the app, not the hard drive.)

## Running in the cloud (no computer at home needed)

The same code runs hosted, using two free services: **Render** (runs the app, gives it HTTPS and a public address) and **Supabase** (holds the database and all the files). In cloud mode the app is protected by a team login password, video transcription is off (type notes instead), and the offline phone mode still works.

1. **Supabase** (supabase.com, free): create a project. Note three values: the **Session pooler** connection string (Connect button), the **Project URL** and the **service_role key** (Settings → API).
2. **Render** (render.com, free): New → Blueprint → connect this GitHub repo. It reads `render.yaml`. Fill in the four environment variables: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `APP_PASSWORD` (the team login you choose).
3. First deploy seeds the cloud with the templates, checklists, catalogue and sample job from the repo. To bring across the real business from a computer that has it, run the migration there once:
   `DATABASE_URL='...' SUPABASE_URL='...' SUPABASE_SERVICE_KEY='...' runtime/bin/node scripts/migrate_to_cloud.js`
4. **Custom domain**: in Render → Settings → Custom Domains, add e.g. `tool.backyardsplashes.com.au`, then create the CNAME record it shows you at your DNS provider.

Free-tier honesty: the server sleeps after ~15 idle minutes (first open of the day takes ~30-60 seconds), Supabase's free database pauses if untouched for a week (opening the app wakes it), and files are capped at 50 MB each.

## Setting up on a new computer (from the GitHub copy)

The GitHub repository holds the system itself — the code, docs, price templates, checklists and the sample job. It deliberately leaves out live business data (customers, jobs, quotes, photos, costs), the scraped catalogue media, and the bundled Node runtime. To stand it up fresh:

1. Install Node.js 22+ (nodejs.org), then in the project folder: `npm install`
2. Rebuild the catalogue media (needs internet, ~10 min):
   `node scripts/build_catalogue.js && node scripts/build_catalogue_docs.js && node scripts/build_decking.js`
3. `npm start` and open http://localhost:4321

To move the actual business (data and all) to a new machine, don't use GitHub — copy the whole folder directly.

## This system does NOT handle council approvals

Each job carries a simple approval status field (not checked / not required / lodged / approved) so you know where things stand, but the approvals work itself lives elsewhere. This system is installation only.
