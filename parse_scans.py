#!/usr/bin/env python3
"""Import AfaScan screenshots into a small, reviewable data set.

The script deliberately keeps the OCR text next to the extracted values. OCR is
useful for bootstrapping a new report, but the JSON file remains the canonical
record and can be corrected without losing the original evidence.

Usage:
    uv run parse_scans.py                 # OCR new screenshots and rebuild outputs
    uv run parse_scans.py --no-ocr        # rebuild CSV/dashboard from JSON only

New screenshots can simply be dropped in the input directory. If a value needs
correction, edit data/overrides.json using the source filename as the key and
run the command again.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent
INPUT_DIR = ROOT / "screenshots"
DATA_DIR = ROOT / "data"
MEASUREMENTS_PATH = DATA_DIR / "measurements.json"
OVERRIDES_PATH = DATA_DIR / "overrides.json"
OCR_DIR = DATA_DIR / "ocr"
CSV_PATH = DATA_DIR / "measurements.csv"
DASHBOARD_PATH = ROOT / "dashboard.html"


def number(value: str | None) -> float | None:
    if not value:
        return None
    value = value.replace(",", ".")
    match = re.search(r"-?\d+(?:\.\d+)?", value)
    return float(match.group(0)) if match else None


def integer(value: str | None) -> int | None:
    n = number(value)
    return int(n) if n is not None else None


def ocr_text(image: Path) -> str:
    tesseract = shutil.which("tesseract") or "/opt/homebrew/bin/tesseract"
    if not Path(tesseract).exists() and shutil.which(tesseract) is None:
        raise RuntimeError("Tesseract non trovato: installalo oppure usa --no-ocr")
    result = subprocess.run(
        [tesseract, str(image), "stdout", "-l", "eng", "--psm", "6"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def first(patterns: list[str], text: str) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
        if match:
            return match.group(1)
    return None


def extract_record(image: Path, text: str) -> dict:
    # The top section is stable across AfaScan report versions. Patterns are
    # intentionally permissive because OCR commonly confuses kg, %, and labels.
    report_date = first(
        [r"\b(20\d{2}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}", r"\b(20\d{2}-\d{2}-\d{2})\b"],
        text,
    )
    filename_date = re.search(r"Screenshot_(\d{8})-(\d{6})", image.name)
    if not report_date and filename_date:
        report_date = dt.datetime.strptime(
            filename_date.group(1) + filename_date.group(2), "%Y%m%d%H%M%S"
        ).date().isoformat()

    record = {
        "device": "AfaScan",
        "report_type": "body_composition" if re.search(r"Body Composition Analysis", text, re.IGNORECASE) else "unknown",
        "date": report_date,
        "source_file": image.name,
        "report_id": first([r"\b(20\d{12})\b"], text),
        "height_cm": number(first([r"\b(17\d)\s+30\s+(?:Male|Female)"], text)),
        "gender": first([r"\b(?:17\d)\s+30\s+(Male|Female)\b"], text),
        "weight_kg": number(first([r"Weight\s*=.*?\n\s*([0-9]+[.,][0-9])\s*kg", r"Weight \(kg\)\s+([0-9]+[.,][0-9])"], text)),
        "muscle_mass_kg": number(first([r"Weight\s*=.*?\n\s*[0-9]+[.,][0-9]\s*kg\s+([0-9]+[.,][0-9])\s*kg"], text)),
        "bone_mass_kg": number(first([r"Weight\s*=.*?\n\s*[0-9]+[.,][0-9]\s*kg\s+[0-9]+[.,][0-9]\s*kg\s+([0-9]+[.,][0-9])\s*kg"], text)),
        "body_fat_mass_kg": number(first([r"Weight\s*=.*?\n\s*(?:[0-9]+[.,][0-9]\s*kg\s+){3}([0-9]+[.,][0-9])\s*kg"], text)),
        "skeletal_muscle_mass_kg": number(first([r"Skeletal Muscle Mass \(Kg\).*?\n.*?([0-9]+[.,][0-9])", r"Skeletal Muscle Mass \(kg\).*?\n.*?([0-9]+[.,][0-9])"], text)),
        "bmi": number(first([r"BMI \(kg/m\??2\).*?\n.*?([0-9]+[.,][0-9])"], text)),
        "body_fat_percent": number(first([r"Body Fat Percent \(%\).*?\n.*?([0-9]+[.,][0-9])", r"Body Fat Percent \(%\)\s+([0-9]+[.,][0-9])"], text)),
        "score": integer(first([r"AfaScan\s*\n\s*(\d{2})\s*/\s*100", r"AfaScan\s+(\d{2})\s*/\s*100"], text)),
        "target_weight_kg": number(first([r"Target Weight\s+([0-9]+[.,][0-9])\s*kg"], text)),
        "basal_metabolic_rate_kcal": integer(first([r"Basal Metabolic Rate\s+(\d{3,4})"], text)),
        "visceral_fat_level": integer(first([r"Visceral Fat Level\s+(\d{1,2})"], text)),
        "protein_percent": number(first([r"Protein Percent\s+([0-9]+[.,][0-9])%"], text)),
        "water_percent": number(first([r"Water Percent\s+([0-9]+[.,][0-9])%"], text)),
        "segment_fat_kg": None,
        "segment_lean_kg": None,
        "ocr_status": "ocr",
    }
    return record


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def merge_override(record: dict, overrides: dict) -> dict:
    updated = dict(record)
    patch = overrides.get(record["source_file"], {})
    updated.update(patch)
    updated.setdefault("device", "AfaScan")
    updated.setdefault("report_type", "body_composition")
    return updated


def tidy(records: list[dict]) -> list[dict]:
    records.sort(key=lambda row: (row.get("date") or "", row.get("source_file") or ""))
    for row in records:
        required = [
            "date", "weight_kg", "body_fat_percent", "skeletal_muscle_mass_kg"
        ]
        if row.get("report_type") == "body_composition":
            required.extend(["segment_fat_kg", "segment_lean_kg"])
        row["review_required"] = any(
            row.get(field) is None
            for field in required
        )
    return records


def write_csv(records: list[dict]) -> None:
    fields = [
        "date", "source_file", "weight_kg", "skeletal_muscle_mass_kg", "body_fat_percent",
        "body_fat_mass_kg", "bmi", "basal_metabolic_rate_kcal", "visceral_fat_level",
        "water_percent", "protein_percent", "score", "target_weight_kg", "review_required",
    ]
    segment_names = ["right_arm", "left_arm", "trunk", "right_leg", "left_leg"]
    fields += [f"segment_fat_{name}_kg" for name in segment_names]
    fields += [f"segment_lean_{name}_kg" for name in segment_names]

    def value(row: dict, field: str):
        if field.startswith("segment_fat_"):
            return (row.get("segment_fat_kg") or {}).get(field.removeprefix("segment_fat_").removesuffix("_kg"))
        if field.startswith("segment_lean_"):
            return (row.get("segment_lean_kg") or {}).get(field.removeprefix("segment_lean_").removesuffix("_kg"))
        return row.get(field)

    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows({field: value(row, field) for field in fields} for row in records)


def write_dashboard(records: list[dict]) -> None:
    data = json.dumps(records, ensure_ascii=False, separators=(",", ":"))
    template = (ROOT / "dashboard.template.html").read_text(encoding="utf-8")
    DASHBOARD_PATH.write_text(template.replace("__MEASUREMENTS_JSON__", data), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-ocr", action="store_true", help="non eseguire OCR; usa solo il JSON già presente")
    args = parser.parse_args()

    INPUT_DIR.mkdir(exist_ok=True)
    DATA_DIR.mkdir(exist_ok=True)
    OCR_DIR.mkdir(exist_ok=True)
    existing = {row.get("source_file"): row for row in load_json(MEASUREMENTS_PATH, [])}
    overrides = load_json(OVERRIDES_PATH, {})

    if args.no_ocr:
        existing = {name: merge_override(row, overrides) for name, row in existing.items()}

    if not args.no_ocr:
        for image in sorted(INPUT_DIR.glob("Screenshot_*.png")):
            if image.name in existing and existing[image.name].get("ocr_status") == "manual":
                existing[image.name] = merge_override(existing[image.name], overrides)
                continue
            text = ocr_text(image)
            (OCR_DIR / f"{image.stem}.txt").write_text(text, encoding="utf-8")
            existing[image.name] = merge_override(extract_record(image, text), overrides)

    records = tidy(list(existing.values()))
    MEASUREMENTS_PATH.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_csv(records)
    write_dashboard(records)
    print(f"Referti: {len(records)} | JSON: {MEASUREMENTS_PATH} | Dashboard: {DASHBOARD_PATH}")
    missing = [row["source_file"] for row in records if row.get("review_required")]
    if missing:
        print("Da verificare:")
        for name in missing:
            print(f"  - {name}")


if __name__ == "__main__":
    main()
