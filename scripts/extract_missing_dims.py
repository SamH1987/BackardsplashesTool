#!/usr/bin/env python3
# Finds catalogue models with a manufacturer PDF on file but no recorded
# dimensions, and tries to extract L x W x D from the PDF text. Prints
# candidates for review - does not write anything automatically.
import json, os, re, glob

import fitz

CAT_DIR = "data/catalogue"
DOC_DIR = "data/catalogue-docs"

# metres format: 5.90 x 2.30 x 1.3
m_pattern = re.compile(r'(\d\.\d{1,2})\s*[xX×]\s*(\d\.\d{1,2})\s*[xX×]\s*(\d\.\d{1,2})')
# cm format: 594 x 228 x 137(cm) - also catches the "130/150cm" second-depth style
cm_pattern = re.compile(r'(\d{3,4})\s*[xX×]\s*(\d{3,4})\s*[xX×]\s*(\d{2,4})(?:/\d{2,4})?\s*cm', re.I)

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
        text = "\n".join(p.get_text() for p in doc[:4])
    except Exception as e:
        continue
    m = m_pattern.findall(text)
    if m:
        l, w, d = m[0]
        candidates.append((rec["id"], rec["name"], float(l), float(w), float(d), len(m), "m"))
        continue
    c = cm_pattern.findall(text)
    if c:
        l, w, d = c[0]
        candidates.append((rec["id"], rec["name"], round(int(l)/100, 2), round(int(w)/100, 2), round(int(d)/100, 2), len(c), "cm"))

print(f"{len(candidates)} models with extractable dimensions found:\n")
for id_, name, l, w, d, n, unit in candidates:
    print(f"  {id_:35s} {name:35s} -> {l} x {w} x {d}  ({n} matches, source unit: {unit})")
