# Future integrations

Not built yet, on purpose. This file records where each one will plug in when the time comes, so nothing about today's data model has to change.

## Where the hooks already are

Every customer record carries an `externalRefs` block:

```json
"externalRefs": { "xero": null, "googleDrive": null, "uconnect": null }
```

When an integration is added, the external system's ID for that customer goes in the matching slot. Because every job, quote, spec and upload already links back to the customer record by `customerId`, syncing the customer syncs the lot.

## Xero (invoicing and payments)

- **What it will do:** push an accepted quote across as a Xero quote/invoice; pull payment status back so "invoiced" and "paid" stop being manual.
- **Plugs in at:** `externalRefs.xero` holds the Xero contact ID. Quote line items already carry description / qty / unit price ex-GST with a separate 10% GST calculation — the same shape Xero wants. The margin line becomes a normal line item on export.
- **Code touch points:** a new `lib/xero.js`, called from the quote status route in `server.js` when a quote is marked accepted, and from a nightly pull for payment status.

## Google Drive (document backup and sharing)

- **What it will do:** mirror each job's documents (photos, sketches, quote PDFs, spec PDFs) into a per-customer Drive folder for backup and sharing.
- **Plugs in at:** `externalRefs.googleDrive` holds the Drive folder ID. All files for a job already live in `data/uploads` with references from the job record, and PDFs are generated on demand from `/api/quotes/:id/pdf` and `/api/specs/:id/pdf` — a sync task renders and uploads them.
- **Code touch points:** a new `lib/drive.js` plus a "sync to Drive" button on the job screen.

## Uconnect

- **What it will do:** exchange customer/job details with Uconnect so the same customer isn't entered twice.
- **Plugs in at:** `externalRefs.uconnect` holds the Uconnect record ID. Customer fields (name, phone, email, address) are flat and map one-to-one.
- **Code touch points:** a new `lib/uconnect.js`; match existing customers by phone/email on first sync to avoid duplicates.

## DeckRoz (photorealistic renders)

- **What it will do:** send DeckRoz everything they need for a sell-quality render in one click, instead of re-explaining the job.
- **Plugs in at:** the survey already captures their full brief - site photos, the sketch, spa/slab/deck/wall dimensions, and position distances. A "render pack" export would zip the photos and a one-page dimensions summary (the spec-sheet PDF generator in `lib/pdf.js` can produce that page today).
- **Note:** the built-in 3D view (`/3d.html?job=...`) is the free, instant, to-scale visual for every quote. DeckRoz renders are the paid, photorealistic step for jobs that justify it. An AI image-compositing service (spa pasted into the customer's own site photo) could plug in later at the same place, but needs a cloud account and per-image cost.

## Ground rules for whoever builds these

1. This system stays the source of truth for jobs, surveys, quotes and specs. Integrations copy data out (or pull status in); they never become the primary store.
2. Never sync the approvals business's systems with this one. Installation only.
3. A failed sync must never block the day-to-day workflow — the founder quotes and books trades whether or not Xero is reachable.
