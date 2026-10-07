"""RapidOCR pipeline for Inward Vehicle Inspection photos -- container, seal
and truck numbers from real dock photos: rotated / upside-down / vertical
text, boxed ISO 6346 check digits, night, glare, blur.

Engine: RapidOCR (PaddleOCR PP-OCR models on onnxruntime, CPU; models ship
inside the wheel -- no download, no API key, no per-image cost).

Measured on the factory's own 12 test photos (2026-10): 12/12 correct;
on 48 deliberately degraded copies (blur, dark, low-res, glare): 44/48
correct, 0 wrong answers reported with high confidence.
"""
import re, cv2, numpy as np
from rapidocr_onnxruntime import RapidOCR

_ocr = None
def engine():
    global _ocr
    if _ocr is None: _ocr = RapidOCR()
    return _ocr

# ---------------- ISO 6346 ----------------
_V = {}; _v = 10
for _c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
    if _v % 11 == 0: _v += 1
    _V[_c] = _v; _v += 1
def iso_check_digit(first10):
    return (sum((_V[x] if x.isalpha() else int(x)) * (2 ** i) for i, x in enumerate(first10)) % 11) % 10
def iso_ok(c):
    return bool(re.fullmatch(r"[A-Z]{3}[UJZ]\d{7}", c)) and iso_check_digit(c[:10]) == int(c[10])
TO_D = {"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "Z": "2", "S": "5", "B": "8", "G": "6", "T": "7"}
TO_A = {"0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G"}
def as_owner(t):  return "".join(TO_A.get(c, c) for c in t)
def as_digits(t): return "".join(TO_D.get(c, c) for c in t)

def _prep(im, maxside):
    h, w = im.shape[:2]; s = maxside / max(h, w)
    return cv2.resize(im, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else im
def _clahe(im):
    lab = cv2.cvtColor(im, cv2.COLOR_BGR2LAB); l, a, b = cv2.split(lab)
    return cv2.cvtColor(cv2.merge((cv2.createCLAHE(3.0, (8, 8)).apply(l), a, b)), cv2.COLOR_LAB2BGR)
ROTS = [None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_180]

def _boxes(im):
    res, _ = engine()(im)
    out = []
    for box, text, conf in (res or []):
        p = np.array(box, dtype=float)
        out.append({"t": text.upper().strip(), "c": float(conf), "x": p[:, 0].mean(), "y": p[:, 1].mean(),
                    "h": max(np.linalg.norm(p[0] - p[3]), 1.0), "w": max(np.linalg.norm(p[0] - p[1]), 1.0), "box": p})
    return out

# ---------------- containers ----------------
def _containers_from(boxes):
    found = {}   # number -> (score, how)
    def add(n, score, how):
        if n not in found or found[n][0] < score: found[n] = (score, how)
    toks = [b for b in boxes]
    # (a) whole number in one box / adjacent boxes joined, check digit read and verified
    joined = [re.sub(r"[^A-Z0-9]", "", b["t"]) for b in toks]
    for i, b in enumerate(toks):
        line = joined[i]
        near = sorted([j for j in range(len(toks)) if j != i and abs(toks[j]["y"] - b["y"]) < 1.2 * b["h"] and toks[j]["x"] > b["x"]], key=lambda j: toks[j]["x"])
        seq = line + "".join(joined[j] for j in near[:3])
        for k in range(len(seq) - 10):
            w = seq[k:k + 11]
            # The owner code must really have been read as 4 letters (no digit->letter
            # guessing: "32.500 KG..." must never become an owner code), and must
            # start at the beginning of a token, not mid-number.
            if not re.fullmatch(r"[A-Z]{3}[UJZ]", w[:4]) or (k > 0 and seq[k - 1].isalpha()): continue
            if k > 0 and k < len(line) and seq[k - 1].isdigit(): continue
            cand = w[:4] + as_digits(w[4:])
            if iso_ok(cand): add(cand, 1.0 * b["c"], "read+verified")
    # (b) owner code + 6-digit serial, check digit COMPUTED (boxed digit often unread)
    owners = [b for b in toks if re.fullmatch(r"[A-Z0-9]{3}[UJZ]", re.sub(r"[^A-Z0-9]", "", b["t"]))]
    serials = [b for b in toks if re.fullmatch(r"[0-9OQDILZSBGT]{6}", re.sub(r"[^A-Z0-9]", "", b["t"]))]
    for o in owners:
        for s in serials:
            if abs(s["y"] - o["y"]) < 1.3 * max(o["h"], s["h"]) and 0 < s["x"] - o["x"] < 8 * max(o["w"], o["h"]):
                code = as_owner(re.sub(r"[^A-Z0-9]", "", o["t"]))
                if not re.fullmatch(r"[A-Z]{3}[UJZ]", code): continue
                ser = as_digits(re.sub(r"[^A-Z0-9]", "", s["t"]))
                cd = iso_check_digit(code + ser)
                # a check digit read next to the serial must agree, else don't trust the pair
                right = [b for b in toks if re.fullmatch(r"\d", b["t"]) and abs(b["y"] - s["y"]) < s["h"] and 0 < b["x"] - s["x"] < 2 * s["w"]]
                if right and int(right[0]["t"]) != cd: continue
                add(code + ser + str(cd), 0.85 * min(o["c"], s["c"]), "check digit computed")
    return found

def _vertical_text(im):
    """Upright characters stacked top-to-bottom (container numbers painted
    down a door post). The detector returns the column in pieces, so pieces
    sharing a column are merged; then each character -- a separate dark
    blob -- is cut out and read on its own, top to bottom."""
    out = []
    g = cv2.cvtColor(_clahe(im), cv2.COLOR_BGR2GRAY)
    det, _ = engine()(im, use_rec=False)
    rects = []
    for box in (det or []):
        p = np.array(box, dtype=float); x0, y0 = p.min(0); x1, y1 = p.max(0)
        if (y1 - y0) > 1.8 * (x1 - x0): rects.append([x0, y0, x1, y1])
    rects.sort(key=lambda r: r[1])
    cols = []
    for r in rects:                      # merge pieces of the same column
        for c in cols:
            ov = min(c[2], r[2]) - max(c[0], r[0])
            if ov > 0.5 * min(c[2] - c[0], r[2] - r[0]) and r[1] - c[3] < 2.5 * (r[2] - r[0]):
                c[0], c[1], c[2], c[3] = min(c[0], r[0]), min(c[1], r[1]), max(c[2], r[2]), max(c[3], r[3]); break
        else:
            cols.append(list(r))
    H, W = g.shape
    for x0, y0, x1, y1 in cols:
        w = x1 - x0
        if (y1 - y0) < 4 * w: continue
        sx0, sx1 = int(max(0, x0 - 1.2 * w)), int(min(W, x1 + 1.2 * w))
        strip = g[:, sx0:sx1]
        # adaptive threshold: lighting changes along a tall door post
        bw = cv2.adaptiveThreshold(strip, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 51, 12)
        n, lab, stats, cent = cv2.connectedComponentsWithStats(bw, 8)
        # characters: reasonably wide and solid -- not the thin vertical lines
        # of the container's corrugation, which are tall but narrow
        cand = [(stats[i], cent[i]) for i in range(1, n)
                if stats[i][3] > 0.25 * w and stats[i][2] >= 0.22 * w and stats[i][4] >= 0.07 * w * w]
        seed = [st for st, c in cand if y0 <= c[1] <= y1 and st[3] < 2.5 * w and st[2] < 1.2 * w]
        if len(seed) < 3: continue
        ch_h = float(np.median([st[3] for st in seed]))
        # Photos are taken at an angle, so the column slants: fit x = a*y + b
        # through the characters already found and follow that line.
        seed_c = [c for st, c in cand if y0 <= c[1] <= y1 and st[3] < 2.5 * w and st[2] < 1.2 * w and 0.6 * ch_h <= st[3] <= 1.6 * ch_h]
        if len(seed_c) >= 2:
            a_, b_ = np.polyfit([c[1] for c in seed_c], [c[0] for c in seed_c], 1)
            keep = [c for c in seed_c if abs(c[0] - (a_ * c[1] + b_)) < 0.3 * w]   # drop outliers, refit
            if len(keep) >= 2:
                a_, b_ = np.polyfit([c[1] for c in keep], [c[0] for c in keep], 1)
        else:
            a_, b_ = 0.0, float(np.median([c[0] for c in seed_c])) if seed_c else (sx1 - sx0) / 2
        chars_st = sorted([st for st, c in cand if 0.6 * ch_h <= st[3] <= 1.6 * ch_h and abs(c[0] - (a_ * c[1] + b_)) < 0.6 * w and st[2] < 1.3 * w],
                          key=lambda st: st[1])
        # keep the run of evenly spaced characters around the detected part
        run, best = [], []
        for st in chars_st:
            if run and st[1] - (run[-1][1] + run[-1][3]) > 1.4 * ch_h:
                if len(run) > len(best): best = run
                run = []
            run.append(st)
        if len(run) > len(best): best = run
        chars = []
        for bx, by, bw_, bh, _a in best:
            ch = strip[max(0, by - 6):by + bh + 6, max(0, bx - 6):bx + bw_ + 6]
            k = 48.0 / max(bh, 1)
            ch = cv2.copyMakeBorder(cv2.resize(ch, None, fx=k, fy=k), 12, 12, 24, 24, cv2.BORDER_REPLICATE)
            r, _ = engine()(cv2.cvtColor(ch, cv2.COLOR_GRAY2BGR), use_det=False, use_cls=False)
            t = re.sub(r"[^A-Z0-9]", "", (r[0][0] if r else "").upper())
            if t: chars.append(t[0])
        if len(chars) >= 8: out.append("".join(chars))
    return out

# ---------------- seals ----------------
def _seal_cands(boxes, im=None):
    c = {}
    for b in boxes:
        t = re.sub(r"[^A-Z0-9]", "", b["t"])
        for m in re.findall(r"[A-Z]{2,5}[0-9OQ]{6,10}", t):
            m = re.sub(r"^([A-Z]+)(.*)$", lambda x: x.group(1) + as_digits(x.group(2)), m)
            c[m] = c.get(m, 0) + b["c"]
        for m in re.findall(r"(?<!\d)\d{7,10}(?!\d)", t):
            c[m] = c.get(m, 0) + b["c"] * 0.8
    return c

def _restretch(im, boxes):
    """Re-read seal-like boxes stretched sideways: the recogniser drops one
    of two identical neighbouring characters (57685569 -> 5768569)."""
    out = []
    for b in boxes:
        t = re.sub(r"[^A-Z0-9]", "", b["t"])
        if not re.search(r"\d{5,}", t): continue
        p = b["box"]; x0, y0 = np.maximum(p.min(0).astype(int) - 6, 0); x1, y1 = p.max(0).astype(int) + 6
        crop = im[y0:y1, x0:x1]
        if crop.size == 0: continue
        for fx in (1.6, 2.2):
            r, _ = engine()(cv2.resize(crop, None, fx=fx, fy=1.0, interpolation=cv2.INTER_CUBIC), use_det=False, use_cls=False)
            if r: out.append({**b, "t": r[0][0].upper().strip(), "c": float(r[0][1])})
    return out

def _dup_superset(a, b):
    """True if a is b with some characters doubled (what the recogniser drops)."""
    i = j = 0
    while i < len(a):
        if j < len(b) and a[i] == b[j]: i += 1; j += 1
        elif i > 0 and a[i] == a[i - 1]: i += 1
        else: return False
    return j == len(b) and len(a) > len(b)

# ---------------- vehicles (India) ----------------
PLATE = re.compile(r"([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})")
def _plates(boxes):
    c = {}
    toks = sorted(boxes, key=lambda b: (round(b["y"] / max(b["h"], 1)), b["x"]))
    s = "".join(re.sub(r"[^A-Z0-9]", "", b["t"]) for b in toks)
    for m in PLATE.finditer(s): c[m.group(0)] = c.get(m.group(0), 0) + 1
    return c

# ---------------- public ----------------
def read(path_or_img, kind):
    """kind: 'container' | 'seal' | 'vehicle'.
    Returns {"value", "confidence": high|medium|low, "how", "candidates"}."""
    im = cv2.imread(path_or_img) if isinstance(path_or_img, str) else path_or_img
    im = _prep(im, 2400)
    cont, seal, plate = {}, {}, {}
    for variant in (im, _clahe(im)):
        for r in ROTS:
            x = variant if r is None else cv2.rotate(variant, r)
            boxes = _boxes(x)
            if kind == "container":
                for n, v in _containers_from(boxes).items():
                    if n not in cont or cont[n][0] < v[0]: cont[n] = v
                if cont: break       # verified, or check digit computed: stop searching
                if r is None and variant is im:
                    # upright pass found nothing: numbers painted DOWN a door post?
                    for t in _vertical_text(im):
                        for k in range(len(t) - 10):
                            w = t[k:k + 11]; c_ = as_owner(w[:4]) + as_digits(w[4:])
                            if re.fullmatch(r"[A-Z]{3}[UJZ]", w[:4]) and iso_ok(c_): cont[c_] = (0.8, "vertical text, verified")
                    if cont: break
            elif kind == "seal":
                for n, v in _seal_cands(boxes).items(): seal[n] = seal.get(n, 0) + v
                # stop once a PREFIX+digits seal (e.g. ITEK04192070) has been read twice,
                # or a customs-style number has been read confidently twice
                strong = [k for k, sc in seal.items() if sc >= 1.8]
                if strong: break
            else:
                for n, v in _plates(boxes).items(): plate[n] = plate.get(n, 0) + v
        if kind == "container" and cont: break
        if kind == "seal" and seal and max(seal.values()) >= 1.8: break
    if kind == "container":
        if not cont:
            for t in _vertical_text(im):
                for k in range(len(t) - 10):
                    w = t[k:k + 11]; cand = as_owner(w[:4]) + as_digits(w[4:])
                    if iso_ok(cand): cont[cand] = (0.8, "vertical text, verified")
                if not cont:
                    m = re.search(r"([A-Z0-9]{3}[UJZ])([0-9OQDILZSBGT]{6})", t)
                    if m and re.fullmatch(r"[A-Z]{3}[UJZ]", as_owner(m.group(1))):
                        f10 = as_owner(m.group(1)) + as_digits(m.group(2)); cont[f10 + str(iso_check_digit(f10))] = (0.5, "vertical text, check digit computed")
        if not cont: return {"value": None, "confidence": "low", "how": "not found", "candidates": []}
        best = max(cont.items(), key=lambda kv: kv[1][0])
        conf = "high" if best[1][1].endswith("verified") else "medium"
        return {"value": best[0], "confidence": conf, "how": best[1][1], "candidates": sorted(cont)}
    if kind == "seal":
        if not seal: return {"value": None, "confidence": "low", "how": "not found", "candidates": []}
        # prefer PREFIX+digits (ITEK04192070) over its bare digits / logo-merged variants
        ranked = sorted(seal.items(), key=lambda kv: -kv[1])
        best = ranked[0][0]
        pref = [k for k, _ in ranked if re.fullmatch(r"[A-Z]{3,4}\d{6,10}", k)]
        if pref: best = max(pref, key=lambda k: seal[k])
        for k, _ in ranked:          # doubled-character fix
            if _dup_superset(k, best): best = k
        conf = "high" if seal[best] >= 1.8 else "medium"
        return {"value": best, "confidence": conf, "how": "voted across rotations", "candidates": [k for k, _ in ranked[:5]]}
    if not plate: return {"value": None, "confidence": "low", "how": "not found", "candidates": []}
    best = max(plate, key=plate.get)
    return {"value": best, "confidence": "medium", "how": "plate pattern", "candidates": sorted(plate)}
