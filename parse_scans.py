#!/usr/bin/env python3
"""Import AfaScan screenshots into a small, reviewable data set.

The script deliberately keeps the OCR text next to the extracted values. OCR is
useful for bootstrapping a new report; measurements.json is a generated output,
while the OCR text and overrides preserve the original evidence and corrections.

Usage:
    uv run parse_scans.py                 # OCR only screenshots not yet in the archive
    uv run parse_scans.py --force-ocr     # intentionally rerun OCR for every screenshot
    uv run parse_scans.py --no-ocr        # rebuild CSV/dashboard from JSON and OCR text only

New screenshots can simply be dropped in the input directory. If a value needs
correction, edit data/overrides.json using the source filename as the key and
run the command again.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INPUT_DIR = ROOT / "screenshots"
DATA_DIR = ROOT / "data"
MEASUREMENTS_PATH = DATA_DIR / "measurements.json"
OVERRIDES_PATH = DATA_DIR / "overrides.json"
OCR_DIR = DATA_DIR / "ocr"
CSV_PATH = DATA_DIR / "measurements.csv"
DASHBOARD_PATH = ROOT / "dashboard.html"
SEGMENT_NAMES = ("right_arm", "left_arm", "trunk", "right_leg", "left_leg")
RECORD_FIELDS = {
    "device", "report_type", "date", "source_file", "report_id", "height_cm", "gender",
    "weight_kg", "muscle_mass_kg", "bone_mass_kg", "body_fat_mass_kg",
    "skeletal_muscle_mass_kg", "bmi", "body_fat_percent", "score", "target_weight_kg",
    "basal_metabolic_rate_kcal", "visceral_fat_level", "protein_percent", "water_percent",
    "segment_fat_kg", "segment_lean_kg", "ocr_status", "review_required",
}
OVERRIDE_FIELDS = RECORD_FIELDS - {"device", "report_type", "source_file", "review_required"}
NUMERIC_RANGES = {
    "height_cm": (50, 250), "weight_kg": (20, 400), "muscle_mass_kg": (0, 400),
    "bone_mass_kg": (0, 100), "body_fat_mass_kg": (0, 200),
    "skeletal_muscle_mass_kg": (0, 200), "bmi": (5, 100), "body_fat_percent": (0, 100),
    "score": (0, 100),
    "target_weight_kg": (20, 400), "basal_metabolic_rate_kcal": (500, 5000),
    "visceral_fat_level": (0, 50), "protein_percent": (0, 100), "water_percent": (0, 100),
}
SEGMENT_RANGES = {"segment_fat_kg": (0, 200), "segment_lean_kg": (0, 300)}
INTEGER_FIELDS = {"height_cm", "score", "basal_metabolic_rate_kcal", "visceral_fat_level"}


def number(value: str | None) -> float | None:
    if not value:
        return None
    value = value.replace(",", ".")
    match = re.search(r"-?\d+(?:\.\d+)?", value)
    return float(match.group(0)) if match else None


def integer(value: str | None) -> int | None:
    n = number(value)
    return int(n) if n is not None else None


def finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def validate_numeric(
    value: object, field: str, location: str, bounds: tuple[float, float] | None = None
) -> None:
    if value is None:
        return
    if not finite_number(value):
        raise ValueError(f"{location}.{field}: atteso un numero finito, trovato {value!r}")
    if field in INTEGER_FIELDS and float(value) != int(float(value)):
        raise ValueError(f"{location}.{field}: atteso un intero, trovato {value!r}")
    minimum, maximum = bounds if bounds is not None else NUMERIC_RANGES.get(field, (None, None))
    if minimum is not None and not minimum <= float(value) <= maximum:
        raise ValueError(
            f"{location}.{field}: valore fuori intervallo [{minimum}, {maximum}], trovato {value!r}"
        )


def validate_segment(value: object, field: str, location: str) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(f"{location}.{field}: atteso un oggetto con i segmenti, trovato {value!r}")
    unknown = sorted(set(value) - set(SEGMENT_NAMES))
    if unknown:
        raise ValueError(f"{location}.{field}: segmenti sconosciuti: {', '.join(unknown)}")
    bounds = SEGMENT_RANGES[field]
    for segment, segment_value in value.items():
        validate_numeric(segment_value, f"{field}.{segment}", location, bounds)


def validate_record(record: object, location: str) -> None:
    if not isinstance(record, dict):
        raise ValueError(f"{location}: atteso un oggetto, trovato {record!r}")
    unknown = sorted(set(record) - RECORD_FIELDS)
    if unknown:
        raise ValueError(f"{location}: campi sconosciuti: {', '.join(unknown)}")
    source_file = record.get("source_file")
    if source_file is not None and (not isinstance(source_file, str) or not source_file.strip()):
        raise ValueError(f"{location}.source_file: nome file mancante o non valido")
    if isinstance(source_file, str) and (
        Path(source_file).name != source_file or "/" in source_file or "\\" in source_file
    ):
        raise ValueError(f"{location}.source_file: deve essere un nome file, non un percorso")
    date = record.get("date")
    if date is not None:
        if not isinstance(date, str):
            raise ValueError(f"{location}.date: attesa una data ISO YYYY-MM-DD, trovato {date!r}")
        try:
            dt.date.fromisoformat(date)
        except ValueError as error:
            raise ValueError(f"{location}.date: data ISO non valida {date!r}") from error
    for field in ("device", "report_type", "gender", "report_id", "ocr_status"):
        value = record.get(field)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"{location}.{field}: attesa una stringa, trovato {value!r}")
    if record.get("ocr_status") not in (None, "ocr", "manual"):
        raise ValueError(f"{location}.ocr_status: valore non valido {record['ocr_status']!r}")
    if record.get("review_required") is not None and not isinstance(record["review_required"], bool):
        raise ValueError(f"{location}.review_required: atteso un booleano")
    for field in NUMERIC_RANGES:
        validate_numeric(record.get(field), field, location)
    validate_numeric(record.get("score"), "score", location)
    validate_segment(record.get("segment_fat_kg"), "segment_fat_kg", location)
    validate_segment(record.get("segment_lean_kg"), "segment_lean_kg", location)


def validate_records(records: object, path: Path) -> None:
    if not isinstance(records, list):
        raise ValueError(f"{path}: atteso un array di referti")
    seen: set[str] = set()
    for index, record in enumerate(records):
        location = f"{path}[{index}]"
        validate_record(record, location)
        source_file = record.get("source_file")
        if not source_file:
            raise ValueError(f"{location}.source_file: campo obbligatorio mancante")
        if source_file in seen:
            raise ValueError(f"{path}: source_file duplicato {source_file!r}")
        seen.add(source_file)


def validate_overrides(overrides: object, path: Path) -> None:
    if not isinstance(overrides, dict):
        raise ValueError(f"{path}: atteso un oggetto indicizzato per source_file")
    for source_file, patch in overrides.items():
        location = f"{path}[{source_file!r}]"
        if not isinstance(source_file, str) or not source_file.strip():
            raise ValueError(f"{location}: chiave source_file non valida")
        if not isinstance(patch, dict):
            raise ValueError(f"{location}: atteso un oggetto di correzioni")
        unknown = sorted(set(patch) - OVERRIDE_FIELDS)
        if unknown:
            raise ValueError(f"{location}: campi non modificabili o sconosciuti: {', '.join(unknown)}")
        candidate = {"source_file": source_file, **patch}
        validate_record(candidate, location)


def validate_override_sources(overrides: dict, known_sources: set[str], path: Path) -> None:
    orphaned = sorted(set(overrides) - known_sources)
    if orphaned:
        names = ", ".join(repr(name) for name in orphaned)
        raise ValueError(f"{path}: override senza referto corrispondente: {names}")


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
        "report_type": (
            "body_composition"
            if re.search(r"Body Composition Analysis", text, re.IGNORECASE)
            else "unknown"
        ),
        "date": report_date,
        "source_file": image.name,
        "report_id": first([r"\b(20\d{12})\b"], text),
        "height_cm": number(first([r"\b(17\d)\s+30\s+(?:Male|Female)"], text)),
        "gender": first([r"\b(?:17\d)\s+30\s+(Male|Female)\b"], text),
        "weight_kg": number(
            first(
                [
                    r"Weight\s*=.*?\n\s*([0-9]+[.,][0-9])\s*kg",
                    r"Weight \(kg\)\s+([0-9]+[.,][0-9])",
                ],
                text,
            )
        ),
        "muscle_mass_kg": number(first([r"Weight\s*=.*?\n\s*[0-9]+[.,][0-9]\s*kg\s+([0-9]+[.,][0-9])\s*kg"], text)),
        "bone_mass_kg": number(
            first(
                [
                    r"Weight\s*=.*?\n\s*[0-9]+[.,][0-9]\s*kg\s+"
                    r"[0-9]+[.,][0-9]\s*kg\s+([0-9]+[.,][0-9])\s*kg"
                ],
                text,
            )
        ),
        "body_fat_mass_kg": number(
            first(
                [r"Weight\s*=.*?\n\s*(?:[0-9]+[.,][0-9]\s*kg\s+){3}([0-9]+[.,][0-9])\s*kg"],
                text,
            )
        ),
        "skeletal_muscle_mass_kg": number(
            first(
                [
                    r"Skeletal Muscle Mass \(Kg\).*?\n.*?([0-9]+[.,][0-9])",
                    r"Skeletal Muscle Mass \(kg\).*?\n.*?([0-9]+[.,][0-9])",
                ],
                text,
            )
        ),
        "bmi": number(first([r"BMI \(kg/m\??2\).*?\n.*?([0-9]+[.,][0-9])"], text)),
        "body_fat_percent": number(
            first(
                [
                    r"Body Fat Percent \(%\).*?\n.*?([0-9]+[.,][0-9])",
                    r"Body Fat Percent \(%\)\s+([0-9]+[.,][0-9])",
                ],
                text,
            )
        ),
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
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"{path}: JSON non valido alla riga {error.lineno}, colonna {error.colno}") from error


def merge_override(record: dict, overrides: dict) -> dict:
    updated = dict(record)
    patch = overrides.get(record["source_file"], {})
    updated.update(patch)
    updated.setdefault("device", "AfaScan")
    updated.setdefault("report_type", "body_composition")
    return updated


def restored_record(record: dict) -> dict:
    source_file = record["source_file"]
    ocr_path = OCR_DIR / f"{Path(source_file).stem}.txt"
    if not ocr_path.exists():
        return dict(record)
    return extract_record(Path(source_file), ocr_path.read_text(encoding="utf-8"))


def complete_segment(value: object) -> bool:
    return isinstance(value, dict) and all(finite_number(value.get(name)) for name in SEGMENT_NAMES)


def tidy(records: list[dict]) -> list[dict]:
    records.sort(key=lambda row: (row.get("date") or "", row.get("source_file") or ""))
    for row in records:
        required = [
            "date", "weight_kg", "body_fat_percent", "skeletal_muscle_mass_kg"
        ]
        if row.get("report_type") == "body_composition":
            required.extend(["segment_fat_kg", "segment_lean_kg"])
        row["review_required"] = any(row.get(field) is None for field in required)
        if row.get("report_type") == "body_composition":
            row["review_required"] = row["review_required"] or not complete_segment(row.get("segment_fat_kg"))
            row["review_required"] = row["review_required"] or not complete_segment(row.get("segment_lean_kg"))
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

    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    writer.writerows({field: value(row, field) for field in fields} for row in records)
    atomic_write_text(CSV_PATH, output.getvalue())


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as handle:
            temporary_path = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def write_dashboard(records: list[dict]) -> None:
    data = json.dumps(records, ensure_ascii=False, separators=(",", ":"))
    data = data.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    template = (ROOT / "dashboard.template.html").read_text(encoding="utf-8")
    atomic_write_text(DASHBOARD_PATH, template.replace("__MEASUREMENTS_JSON__", data))


def import_images(
    existing: dict[str, dict], overrides: dict, images: list[Path], force_ocr: bool = False
) -> dict[str, dict]:
    imported = dict(existing)
    for image in sorted(images):
        if image.name in imported and not force_ocr:
            imported[image.name] = merge_override(imported[image.name], overrides)
            continue
        text = ocr_text(image)
        (OCR_DIR / f"{image.stem}.txt").write_text(text, encoding="utf-8")
        imported[image.name] = merge_override(extract_record(image, text), overrides)
    return imported


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-ocr", action="store_true", help="non eseguire OCR; usa solo il JSON già presente")
    parser.add_argument(
        "--force-ocr", action="store_true", help="riesegui intenzionalmente l'OCR sui file già importati"
    )
    args = parser.parse_args()
    if args.no_ocr and args.force_ocr:
        parser.error("--no-ocr e --force-ocr sono alternativi")

    INPUT_DIR.mkdir(exist_ok=True)
    DATA_DIR.mkdir(exist_ok=True)
    OCR_DIR.mkdir(exist_ok=True)
    raw_records = load_json(MEASUREMENTS_PATH, [])
    validate_records(raw_records, MEASUREMENTS_PATH)
    existing = {row["source_file"]: restored_record(row) for row in raw_records}
    overrides = load_json(OVERRIDES_PATH, {})
    validate_overrides(overrides, OVERRIDES_PATH)
    images = list(INPUT_DIR.glob("Screenshot_*.png"))
    validate_override_sources(overrides, set(existing) | {image.name for image in images}, OVERRIDES_PATH)
    existing = {name: merge_override(row, overrides) for name, row in existing.items()}

    if not args.no_ocr:
        existing = import_images(existing, overrides, images, force_ocr=args.force_ocr)

    records = tidy(list(existing.values()))
    validate_records(records, MEASUREMENTS_PATH)
    atomic_write_text(MEASUREMENTS_PATH, json.dumps(records, ensure_ascii=False, indent=2) + "\n")
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
