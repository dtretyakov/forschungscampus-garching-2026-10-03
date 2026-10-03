#!/usr/bin/env python3
"""Georeference the official Lageplan (PDF page 1) against OpenStreetMap.

1. Render the plan and find the highlighted (purple) buildings by colour.
2. Start from a few hand-picked control points (U-Bahn, bus stops, buildings),
   then iteratively match every purple building to the OSM building outline
   it lands on and refit an affine transform PDF-points -> metres.
3. Write data/georef.json: the transform, the label positions of all station
   numbers (1 .. 29, 11.1 .. 11.7) and map symbols (info, food, bus, parking)
   converted to lat/lng.

Needs: poppler-utils (pdftoppm, pdftotext), numpy, scipy, Pillow.
"""
import json
import math
import os
import re
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PDF = os.path.join(ROOT, "sources/files/wp-content_uploads_2026_09_TdoT2026_Lageplan.pdf")
OSM = os.path.join(ROOT, "sources/osm_geom.json")
OUT = os.path.join(ROOT, "data/georef.json")
WEBPLAN = os.path.join(ROOT, "sources/pages/3-okt-2026_lageplan.html")
DPI = 150
S = DPI / 72.0           # pixels per PDF point
MAP_MAX_Y = 590          # PDF points: everything below is the brochure text
MAP_MIN_X = 150          # left of this is the legend / U-Bahn inset

LAT0, LNG0 = 48.2640, 11.6700
MLAT = 111_132.0
MLNG = 111_320.0 * math.cos(math.radians(LAT0))


def to_m(lat, lng):
    return ((lng - LNG0) * MLNG, (lat - LAT0) * MLAT)


def to_ll(x, y):
    return (LAT0 + y / MLAT, LNG0 + x / MLNG)


# Rough initial control points: PDF point (x, y) -> (lat, lng).
SEED = [
    ((568.1, 314.1), (48.26474, 11.67141)),  # U Garching-Forschungszentrum
    ((497.4, 463.4), (48.26117, 11.66844)),  # Bus Boltzmannstraße
    ((258.5, 430.0), (48.26196, 11.66197)),  # Bus Anna-Boyksen-Straße
    ((590.3, 260.5), (48.26540, 11.67227)),  # Galileo
    ((209.4, 494.1), (48.26068, 11.65946)),  # Werkfeuerwehr TUM
    ((517.0, 98.0), (48.26881, 11.66969)),   # Chemie
]


def render():
    tmp = tempfile.mkdtemp()
    subprocess.run(["pdftoppm", "-f", "1", "-l", "1", "-r", str(DPI), "-png", PDF, os.path.join(tmp, "p")], check=True)
    png = [f for f in os.listdir(tmp) if f.endswith(".png")][0]
    return np.asarray(Image.open(os.path.join(tmp, png)).convert("RGB")).astype(int)


def mask(img, rgb, tol=40):
    d = np.abs(img - np.array(rgb)).sum(axis=2)
    m = d < tol
    m[int(MAP_MAX_Y * S):, :] = False
    m[:, : int(MAP_MIN_X * S)] = False
    return m


def blobs(m, min_px):
    lab, n = ndimage.label(m)
    out = []
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        area = int((lab[sl] == i).sum())
        if area < min_px:
            continue
        cy, cx = ndimage.center_of_mass(lab == i)
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        out.append({"x": cx / S, "y": cy / S, "area_pt2": area / S / S, "aspect": w / h})
    return out


def dedupe(pts, r=4.0):
    out = []
    for p in pts:
        if all(math.dist((p["x"], p["y"]), (q["x"], q["y"])) > r for q in out):
            out.append(p)
    return out


def snap(purple_mask, labs):
    """Move each number label onto its highlighted building.

    Labels are white circles with a purple ring drawn next to (or on) the building.
    If the label sits inside the building it is kept; otherwise it moves to the
    nearest purple building pixel (ring pixels of all labels excluded), 4 pt inside.
    """
    m = purple_mask.copy()
    yy, xx = np.mgrid[0:m.shape[0], 0:m.shape[1]]
    rings = []
    for k, (x, y, r) in labs.items():
        X, Y, R = x * S, y * S, (r + 1.5) * S
        y0, y1, x0, x1 = int(Y - R), int(Y + R) + 1, int(X - R), int(X + R) + 1
        sub = (yy[y0:y1, x0:x1] - Y) ** 2 + (xx[y0:y1, x0:x1] - X) ** 2 <= R * R
        m[y0:y1, x0:x1][sub] = False
        rings.append((X, Y, R))
    py, px = np.nonzero(m)
    out = {}
    for k, (x, y, r) in labs.items():
        X, Y, R = x * S, y * S, (r + 1.5) * S
        d = np.hypot(px - X, py - Y)
        ann = (d > R) & (d < R + 4 * S)
        circ = 2 * math.pi * (R + 2 * S) * 4 * S
        if ann.sum() > 0.6 * circ:
            out[k] = (x, y, "inside")
            continue
        i = int(np.argmin(d))
        if d[i] > 30 * S:
            out[k] = (x, y, "far")
            continue
        vx, vy = (px[i] - X) / d[i], (py[i] - Y) / d[i]
        out[k] = ((px[i] + vx * 4 * S) / S, (py[i] + vy * 4 * S) / S, "snapped")
    return out


def labels():
    """Station numbers on the map with their PDF coordinates (pdftotext -bbox)."""
    html = subprocess.run(["pdftotext", "-f", "1", "-l", "1", "-bbox", PDF, "-"], check=True, capture_output=True, text=True).stdout
    out = {}
    for m in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>', html):
        x0, y0, x1, y1 = map(float, m.groups()[:4])
        w = m.group(5)
        h = y1 - y0
        # Building numbers are set at 12.4pt (19.2 for 17/18, 16.5 for 1), sub-numbers 8.2pt.
        if y0 < MAP_MAX_Y and x0 > MAP_MIN_X and re.fullmatch(r"\d{1,2}(\.\d)?", w) and h >= 8:
            if "." not in w and h < 12:
                continue  # bus line numbers etc.
            out[w] = ((x0 + x1) / 2, (y0 + y1) / 2, max(h, x1 - x0) * 0.75)
    return out


def web_plan_points():
    """Clickable circles of the online Lageplan (SVG over the web PNG), incl. sub-stations like 17.3."""
    if not os.path.exists(WEBPLAN):
        return {}
    h = open(WEBPLAN, encoding="utf-8").read()
    out = {}
    for cx, cy, num in re.findall(r'<circle cx="([\d.]+)" cy="([\d.]+)"[^>]*></circle><title>\(([\d.]+)\)', h):
        out.setdefault(num, (float(cx), float(cy)))
    return out


def osm_buildings():
    d = json.load(open(OSM))
    res = []
    for e in d["elements"]:
        if e["type"] != "way" or "building" not in e.get("tags", {}) or "geometry" not in e:
            continue
        pts = np.array([to_m(p["lat"], p["lon"]) for p in e["geometry"]])
        if len(pts) < 4:
            continue
        x, y = pts[:, 0], pts[:, 1]
        a = 0.5 * np.sum(x[:-1] * y[1:] - x[1:] * y[:-1])
        if abs(a) < 30:
            continue
        cx = np.sum((x[:-1] + x[1:]) * (x[:-1] * y[1:] - x[1:] * y[:-1])) / (6 * a)
        cy = np.sum((y[:-1] + y[1:]) * (x[:-1] * y[1:] - x[1:] * y[:-1])) / (6 * a)
        res.append({"id": e["id"], "name": e["tags"].get("name", ""), "poly": pts, "c": (cx, cy), "area": abs(a)})
    return res


def inside(pt, poly):
    x, y = pt
    xs, ys = poly[:, 0], poly[:, 1]
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        if (ys[i] > y) != (ys[j] > y) and x < (xs[j] - xs[i]) * (y - ys[i]) / (ys[j] - ys[i] + 1e-12) + xs[i]:
            c = not c
        j = i
    return c


def fit(src, dst):
    A = np.hstack([np.array(src), np.ones((len(src), 1))])
    M, *_ = np.linalg.lstsq(A, np.array(dst), rcond=None)
    return M  # 3x2


def apply(M, p):
    return tuple(np.array([p[0], p[1], 1.0]) @ M)


def main():
    img = render()
    pmask = mask(img, (148, 5, 79))
    purple = blobs(pmask, min_px=int(20 * S * S))
    print(f"{len(purple)} highlighted buildings on the plan", file=sys.stderr)
    bld = osm_buildings()

    M = fit([s for s, _ in SEED], [to_m(*d) for _, d in SEED])
    pairs = []
    for it in range(6):
        pairs = []
        for b in purple:
            p = apply(M, (b["x"], b["y"]))
            # the OSM building whose outline contains the projected centroid, else nearest centroid
            hit = [o for o in bld if inside(p, o["poly"])]
            if not hit:
                hit = sorted(bld, key=lambda o: math.dist(p, o["c"]))[:1]
            o = hit[0]
            # plan area in m² under the current transform
            det = abs(np.linalg.det(M[:2, :]))
            area_plan = b["area_pt2"] * det
            ratio = area_plan / o["area"]
            if math.dist(p, o["c"]) < 45 and 0.4 < ratio < 2.5:
                pairs.append(((b["x"], b["y"]), o["c"], o["name"], math.dist(p, o["c"]), ratio))
        src = [s for s, *_ in pairs] + [s for s, _ in SEED]
        dst = [d for _, d, *_ in pairs] + [to_m(*d) for _, d in SEED]
        w = len(pairs)
        # drop the worst 15% matches after the first rounds (outliers / mismatched buildings)
        if it >= 2 and pairs:
            res = [math.dist(apply(M, s), d) for s, d in zip(src, dst)]
            keep = np.argsort(res)[: max(6, int(len(res) * 0.85))]
            src = [src[i] for i in keep]
            dst = [dst[i] for i in keep]
        M = fit(src, dst)
        res = [math.dist(apply(M, s), d) for s, d in zip(src, dst)]
        print(f"iter {it}: {w} matched buildings, rms {np.sqrt(np.mean(np.square(res))):.1f} m, max {max(res):.1f} m", file=sys.stderr)

    for (s, c, name, dd, r) in pairs:
        print(f"  matched {name or '(unnamed)':40s} plan({s[0]:.0f},{s[1]:.0f}) d={dd:5.1f}m area-ratio={r:.2f}", file=sys.stderr)

    # Scale/rotation sanity check
    sx = math.hypot(*M[0, :]); sy = math.hypot(*M[1, :])
    rot = math.degrees(math.atan2(M[0, 1], M[0, 0]))
    print(f"scale {sx:.2f} / {sy:.2f} m per pt, rotation {rot:.1f}°", file=sys.stderr)

    out = {"transform_pdf_pt_to_m": M.tolist(), "origin": [LAT0, LNG0], "labels": {}, "symbols": {}}
    labs = labels()
    for k, (x, y, how) in snap(pmask, labs).items():
        out["labels"][k] = {"lat_lng": [round(v, 6) for v in to_ll(*apply(M, (x, y)))],
                            "plan_pt": [round(x, 1), round(y, 1)], "label_pt": [round(labs[k][0], 1), round(labs[k][1], 1)], "how": how}
        print(f"  label {k:5s} {how}", file=sys.stderr)

    # Sub-stations (17.1, 18.6, ...) exist only on the online plan: map web-PNG pixels -> PDF points
    # with an affine fit on the numbers present in both, then through the same georeference.
    web = web_plan_points()
    common = [k for k in web if k in labs]
    if len(common) >= 6:
        src = [web[k] for k in common]
        dst = [labs[k][:2] for k in common]
        A = fit(src, dst)
        res = [math.dist(apply(A, a), b) for a, b in zip(src, dst)]
        keep = [i for i, r in enumerate(res) if r < 5]  # building-level "info" circles sometimes moved
        A = fit([src[i] for i in keep], [dst[i] for i in keep])
        res = [math.dist(apply(A, src[i]), dst[i]) for i in keep]
        print(f"web plan: {len(web)} circles, fit on {len(keep)}, rms {np.sqrt(np.mean(np.square(res))):.1f} pt", file=sys.stderr)
        for k, w in web.items():
            if k in out["labels"]:
                continue
            x, y = apply(A, w)
            out["labels"][k] = {"lat_lng": [round(v, 6) for v in to_ll(*apply(M, (x, y)))],
                                "plan_pt": [round(x, 1), round(y, 1)], "label_pt": [round(x, 1), round(y, 1)], "how": "web-plan"}

    # Map symbols by colour: info stands (pink), gastronomy (orange), bus (yellow), parking/U (blue)
    sym = {
        "info": ((226, 76, 174), 25),
        "food": ((245, 126, 20), 25),
        "bus": ((255, 237, 0), 15),
        "blue": ((33, 85, 173), 25),
    }
    for name, (rgb, minpt) in sym.items():
        pts = dedupe(blobs(mask(img, rgb, tol=60), min_px=int(minpt * S)))
        pts = [b for b in pts if b["x"] > 160 and 0.75 < b["aspect"] < 1.33]  # drop inset map and route signs
        out["symbols"][name] = [[round(v, 6) for v in to_ll(*apply(M, (b["x"], b["y"])))] + [round(b["x"], 1), round(b["y"], 1)] for b in pts]
        print(f"{name}: {len(pts)}", file=sys.stderr)

    # Plan corners, for an optional image overlay of the plan
    W, H = img.shape[1] / S, img.shape[0] / S
    out["corners"] = {k: [round(v, 6) for v in to_ll(*apply(M, p))] for k, p in
                      {"tl": (0, 0), "tr": (W, 0), "bl": (0, MAP_MAX_Y), "br": (W, MAP_MAX_Y)}.items()}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print("wrote", OUT, file=sys.stderr)


if __name__ == "__main__":
    main()
