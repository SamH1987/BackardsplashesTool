#!/usr/bin/env python3
# Finds catalogue models with a manufacturer PDF on file but no recorded
# dimensions, and tries to extract L x W x D from the PDF text. Prints
# candidates for review - does not write anything automatically.
import json, os, re, glob

import fitz

CAT_DIR = "data/catalogue"
DOC_DIR = "data/catalogue-docs"

dim_pattern = re.compile(r'(\d\.\d{1,2})\s*[xX×]\s*(\d\.\d{1,2})\s*[xX×]\s*(\d\.\d{1,2})')

candidates = []
for f in sorted(glob.glob(CAT_DIR + "/*.json")):
    rec = json.load(open(f))
    if rec.get("lengthM") or not rec.get("docFile"):
        continue
    doc_path = os.path.join(DOC_DIR, rec["docFile"])
    if not os.path.exists(doc_path):
        continue
    try:
        doc = fitz.open(doc_path)
        text = "\n".join(p.get_text() for p in doc[:3])
    except Exception as e:
        continue
    matches = dim_pattern.findall(text)
    if matches:
        # take the first match found - usually the headline dimension
        l, w, d = matches[0]
        candidates.append((rec["id"], rec["name"], l, w, d, len(matches)))

print(f"{len(candidates)} models with extractable dimensions found:\n")
for id_, name, l, w, d, n in candidates:
    print(f"  {id_:35s} {name:35s} -> {l} x {w} x {d}  ({n} matches in doc)")
