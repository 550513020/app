"""Local-only adapter for the open-source homr OMR command line."""
from __future__ import annotations

import json
import asyncio
import os
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from statistics import median
from pathlib import Path
from PIL import Image
import numpy as np

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

app = FastAPI(title="P2K local OMR", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8000", "http://localhost:8000"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def local_homr() -> list[str]:
    path = shutil.which("homr")
    if path:
        return [path]
    try:
        import importlib.util
        installed = importlib.util.find_spec("homr") is not None
    except (ImportError, ValueError):
        installed = False
    if not installed:
        raise HTTPException(503, "未安装 homr。请按 README 安装本机识谱引擎后重试。")
    return [os.sys.executable, "-c", "from homr.main import main; main()"]


def midi(note: ET.Element) -> int | None:
    pitch = note.find("pitch")
    if pitch is None:
        return None
    step = pitch.findtext("step")
    octave = pitch.findtext("octave")
    if step not in {"C", "D", "E", "F", "G", "A", "B"} or octave is None:
        return None
    semitones = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    alter = int(float(pitch.findtext("alter") or "0"))
    return (int(octave) + 1) * 12 + semitones[step] + alter


def score_x_bounds(image_path: Path, width: int, height: int) -> tuple[float, float]:
    """Find long horizontal staff-line spans so beat markers avoid page margins."""
    with Image.open(image_path) as image:
        gray = np.asarray(image.convert("L"))
    spans: list[tuple[int, int]] = []
    min_run = int(width * 0.38)
    for y in range(int(height * 0.12), int(height * 0.94), 2):
        xs = np.flatnonzero(gray[y, :] < 150)
        if len(xs) < min_run:
            continue
        splits = np.flatnonzero(np.diff(xs) > 1) + 1
        groups = np.split(xs, splits)
        run = max(groups, key=len)
        if len(run) >= min_run:
            spans.append((int(run[0]), int(run[-1])))
    if not spans:
        return 0.10, 0.95
    left = min(a for a, _ in spans) / width
    right = max(b for _, b in spans) / width
    if right - left < 0.4:
        return 0.10, 0.95
    return max(0.0, left), min(1.0, right)


def score_system_measure_counts(image_path: Path) -> list[int]:
    """Estimate measures per printed system from staff-line and barline pixels."""
    with Image.open(image_path) as image:
        gray = np.asarray(image.convert("L"))
    height, width = gray.shape
    dark = gray < 160
    horizontal = dark.sum(axis=1)
    ys = np.flatnonzero(horizontal >= width * 0.38)
    bands: list[list[int]] = []
    for y in ys:
        if not bands or y > bands[-1][-1] + 2:
            bands.append([int(y)])
        else:
            bands[-1].append(int(y))
    line_y = [int(round(sum(group) / len(group))) for group in bands]
    staves: list[list[int]] = []
    for y in line_y:
        if not staves or y - staves[-1][-1] > max(18, round(height * 0.012)):
            staves.append([y])
        else:
            staves[-1].append(y)
    staves = [group for group in staves if len(group) >= 4]
    counts: list[int] = []
    for i in range(0, len(staves) - 1, 2):
        top, bottom = staves[i][0], staves[i + 1][-1]
        band_height = bottom - top + 1
        if band_height <= 0:
            continue
        projection = dark[top:bottom + 1].sum(axis=0)
        xs = np.flatnonzero(projection >= band_height * 0.72)
        boundaries: list[list[int]] = []
        for x in xs:
            if not boundaries or x > boundaries[-1][-1] + 3:
                boundaries.append([int(x)])
            else:
                boundaries[-1].append(int(x))
        # A printed system has a start and end barline; their intervals are measures.
        boundary_count = sum(1 for group in boundaries if max(projection[group]) >= band_height * 0.82)
        if boundary_count >= 3:
            counts.append(boundary_count - 1)
    return counts


def parse_musicxml(path: Path, width: int, height: int, page_number: int, score_bounds: tuple[float, float], system_measure_counts: list[int] | None = None) -> list[dict]:
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
    root = ET.parse(path, parser=parser).getroot()
    events: dict[tuple[int, float], dict] = {}
    measure_xs: dict[int, list[float]] = defaultdict(list)
    measure_ys: dict[int, list[float]] = defaultdict(list)
    parts = root.findall("part")
    for part_index, part in enumerate(parts):
        # MusicXML attributes are inherited: divisions and time signature are often
        # written only in the first measure of a part. Carry them forward instead
        # of silently reverting to one tick per beat at every bar.
        divisions = 1
        meter = None
        for measure_index, measure in enumerate(part.findall("measure")):
            divisions_text = measure.findtext("attributes/divisions")
            if divisions_text:
                divisions = max(1, int(float(divisions_text)))
            time_node = measure.find("attributes/time")
            if time_node is not None:
                beats = time_node.findtext("beats")
                beat_type = time_node.findtext("beat-type")
                if beats and beat_type:
                    meter = f"{beats}/{beat_type}"
            cursor = 0
            onset_for_chord = 0
            imgpos = None
            for child in list(measure):
                if child.tag is ET.Comment:
                    match = re.search(r"imgpos\s*:\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)", child.text or "")
                    if match:
                        imgpos = (float(match.group(1)), float(match.group(2)))
                    continue
                if child.tag == "backup":
                    cursor -= int(child.findtext("duration") or "0")
                    continue
                if child.tag == "forward":
                    cursor += int(child.findtext("duration") or "0")
                    continue
                if child.tag != "note":
                    continue
                is_chord = child.find("chord") is not None
                onset = onset_for_chord if is_chord else cursor
                if not is_chord:
                    onset_for_chord = cursor
                duration_ticks = int(child.findtext("duration") or str(divisions))
                duration_beats = max(.25, min(4.0, duration_ticks / divisions))
                staff = int(child.findtext("staff") or str(part_index + 1))
                key = (measure_index, round(onset / divisions, 4))
                ev = events.setdefault(key, {
                    "label": f"第 {measure_index + 1} 小节",
                    "page": page_number,
                    "measure": measure_index + 1,
                    "row": measure_index // 4 + 1,
                    "beat": key[1],
                    "durationBeats": duration_beats,
                    "meter": meter,
                    "notes": [],
                })
                pitch = midi(child)
                if pitch is not None:
                    x, y = imgpos if imgpos else (None, None)
                    ev["notes"].append({"m": pitch, "h": "R" if staff == 1 else "L", "f": None, "xRaw": x, "yRaw": y, "page": 1})
                    if x is not None:
                        measure_xs[measure_index + 1].append(x)
                    if y is not None:
                        measure_ys[measure_index + 1].append(y)
                if not is_chord:
                    cursor += duration_ticks
                imgpos = None
    ordered = sorted(events.values(), key=lambda e: (int(e["label"].split()[1]), e["beat"]))
    all_x = [n["xRaw"] for e in ordered for n in e["notes"] if n["xRaw"] is not None]
    all_y = [n["yRaw"] for e in ordered for n in e["notes"] if n["yRaw"] is not None]
    measure_count = max((int(e["label"].split()[1]) for e in ordered), default=1)
    # Detect system breaks from MusicXML image positions. Measure note x positions
    # move left again when the score wraps to the next printed line.
    measure_rows: dict[int, int] = {}
    measure_slots: dict[int, int] = {}
    layout_from_image = bool(system_measure_counts)
    if system_measure_counts:
        row_number = 1
        slot = 0
        for measure_number in range(1, measure_count + 1):
            while row_number < len(system_measure_counts) and slot >= system_measure_counts[row_number - 1]:
                row_number += 1
                slot = 0
            measure_rows[measure_number] = row_number
            measure_slots[measure_number] = slot
            slot += 1
    previous_x = None
    previous_y = None
    current_row = 1
    slot_in_row = 0
    if not system_measure_counts:
        for measure_number in range(1, measure_count + 1):
            xs = measure_xs.get(measure_number, [])
            ys = measure_ys.get(measure_number, [])
            center_x = median(xs) if xs else None
            center_y = median(ys) if ys else None
            x_reset = center_x is not None and previous_x is not None and center_x < previous_x - width * 0.12
            y_reset = center_y is not None and previous_y is not None and center_y > previous_y + height * 0.08
            if x_reset or y_reset:
                current_row += 1
                slot_in_row = 0
            measure_rows[measure_number] = current_row
            measure_slots[measure_number] = slot_in_row
            slot_in_row += 1
            if center_x is not None:
                previous_x = center_x
            if center_y is not None:
                previous_y = center_y
    if not measure_xs and not system_measure_counts:
        for measure_number in range(1, measure_count + 1):
            measure_rows[measure_number] = (measure_number - 1) // 4 + 1
            measure_slots[measure_number] = (measure_number - 1) % 4
    measures_per_row: dict[int, int] = defaultdict(int)
    for row in measure_rows.values():
        measures_per_row[row] += 1
    row_count = max(measure_rows.values(), default=1)
    system_count = max(1, row_count)
    # homr provides approximate image coordinates in MusicXML comments. Normalize against
    # the observed score extent with margin; positions remain editable in the browser.
    xmax = max(width, max(all_x, default=1))
    ymax = max(height, max(all_y, default=1))
    score_left, score_right = score_bounds
    for i, ev in enumerate(ordered):
        measure = int(ev["label"].split()[1]) - 1
        measure_number = measure + 1
        row_number = measure_rows.get(measure_number, 1)
        measure_slot = measure_slots.get(measure_number, measure % 4)
        meter = ev.get("meter") or "4/4"
        try:
            meter_num, meter_den = (int(part) for part in meter.split("/", 1))
            measure_quarter_beats = max(0.25, meter_num * 4.0 / meter_den)
        except (ValueError, ZeroDivisionError):
            measure_quarter_beats = 4.0
        beat_in_measure = max(0.0, min(measure_quarter_beats, float(ev["beat"])))
        # Fallback note positions use the actual measure length, so beats move
        # between adjacent noteheads instead of collapsing onto a barline.
        content_left = min(score_right - 0.08, score_left + 0.055)
        row_measure_count = max(1, measures_per_row.get(row_number, 4))
        estimated_x = content_left + (score_right - content_left) * (measure_slot + beat_in_measure / measure_quarter_beats) / row_measure_count
        system = row_number - 1
        ev["row"] = row_number
        ev["rowSource"] = "image" if layout_from_image else "estimated"
        ev["label"] = f"第 {i + 1} 拍 · {ev['label']}"
        for note in ev["notes"]:
            note["x"] = min(.99, max(.01, note.pop("xRaw") / xmax)) if note["xRaw"] is not None else estimated_x
            staff_offset = .24 if note["h"] == "R" else .63
            estimated_y = .08 + .84 * (system + staff_offset) / system_count
            note["y"] = min(.98, max(.02, note.pop("yRaw") / ymax)) if note["yRaw"] is not None else estimated_y
            note["page"] = page_number
    return ordered


@app.get("/health")
def health():
    try:
        import importlib.util
        installed = importlib.util.find_spec("homr") is not None
    except (ImportError, ValueError):
        installed = False
    return {"ok": True, "engine": "homr", "installed": installed, "scoreLayout": "image-barline-v1"}


@app.post("/recognize")
async def recognize(images: list[UploadFile] = File(...)):
    if not images or len(images) > 40:
        raise HTTPException(413, "每次可识谱 1 到 40 页。")
    command = local_homr()
    with tempfile.TemporaryDirectory(prefix="p2k-omr-") as directory:
        combined = []
        total_bytes = 0
        for page_number, image in enumerate(images, 1):
            if (image.content_type or "").lower() not in {"image/png", "application/octet-stream"}:
                raise HTTPException(415, "识谱服务只接收本机转换的 PNG 页面。")
            data = await image.read()
            total_bytes += len(data)
            if not data or total_bytes > 100 * 1024 * 1024:
                raise HTTPException(413, "曲谱页图为空或总大小超过 100 MB。")
            source = Path(directory) / f"page-{page_number}.png"
            source.write_bytes(data)
            with Image.open(source) as im:
                width, height = im.size
            try:
                # homr is CPU/GPU-heavy and blocks for tens of seconds. Keep it off
                # uvicorn's event loop so /health and browser connections stay live.
                result = await asyncio.to_thread(
                    subprocess.run, command + [str(source)], cwd=directory,
                    capture_output=True, text=True, timeout=900,
                )
            except subprocess.TimeoutExpired as exc:
                raise HTTPException(504, f"第 {page_number} 页识谱超时。") from exc
            if result.returncode:
                raise HTTPException(422, f"第 {page_number} 页：" + (result.stderr or result.stdout or "识谱失败")[-1200:])
            xml_file = source.with_suffix(".musicxml")
            if not xml_file.exists():
                raise HTTPException(422, f"第 {page_number} 页识谱结束但没有生成 MusicXML。")
            bounds = score_x_bounds(source, width, height)
            system_counts = score_system_measure_counts(source)
            combined.extend(parse_musicxml(xml_file, width, height, page_number, bounds, system_counts))
        if not combined:
            raise HTTPException(422, "未识别到可演奏音符。")
        return JSONResponse({"events": combined, "engine": "homr", "reviewRequired": True, "coordinatesApproximate": True})

