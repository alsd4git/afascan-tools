from pathlib import Path

import pytest

from parse_scans import (
    extract_record,
    import_images,
    number,
    tidy,
    validate_override_sources,
    validate_overrides,
    validate_records,
    write_dashboard,
)


def test_number_accepts_decimal_comma():
    assert number("-12,5 kg") == -12.5


def test_extract_record_reads_stable_report_fields():
    text = """Body Composition Analysis
20260830101500 175 30 Male 2026-08-30 10:15:00
Weight = Muscle Mass + Bone Mass + Body Fat Mass
80.8kg 58.9kg 3.0kg 18.8kg
Skeletal Muscle Mass (kg)
37.5
BMI (kg/m2)
26.4
Body Fat Percent (%)
23.4
AfaScan
68 /100
Target Weight 72.9 kg
Basal Metabolic Rate 1686
Visceral Fat Level 11
Protein Percent 13.8%
Water Percent 51.2%
"""

    record = extract_record(Path("Screenshot_20260830-101500.png"), text)

    assert record["report_type"] == "body_composition"
    assert record["date"] == "2026-08-30"
    assert record["weight_kg"] == 80.8
    assert record["body_fat_percent"] == 23.4
    assert record["score"] == 68
    assert record["water_percent"] == 51.2


def test_extract_record_tolerates_common_ocr_label_separators():
    text = """Body Composition Analysis
BasalMetabolicRate 1693
Water Percent) = 51.0%
Body Composition Analysis | AfaScan
100% 72.7% 3.7% 23.6% | 68 100
Skeletal Muscle Mass (kg) 70 100 37.6
BMI m 26.3
"""

    record = extract_record(Path("Screenshot_20260612-173147.png"), text)

    assert record["basal_metabolic_rate_kcal"] == 1693
    assert record["water_percent"] == 51.0
    assert record["score"] == 68
    assert record["skeletal_muscle_mass_kg"] == 37.6
    assert record["bmi"] == 26.3


def test_body_composition_without_segment_overrides_requires_review():
    record = extract_record(
        Path("Screenshot_20260830-101500.png"),
        "Body Composition Analysis\n2026-08-30\nWeight (kg) 80.8",
    )

    assert tidy([record])[0]["review_required"] is True


def test_import_images_skips_archived_file_unless_forced(tmp_path, monkeypatch):
    image = tmp_path / "Screenshot_20260830-101500.png"
    image.write_bytes(b"placeholder")
    ocr_dir = tmp_path / "ocr"
    ocr_dir.mkdir()
    calls = []
    monkeypatch.setattr("parse_scans.OCR_DIR", ocr_dir)
    monkeypatch.setattr("parse_scans.ocr_text", lambda path: calls.append(path) or "Body Composition Analysis")
    existing = {image.name: {"source_file": image.name, "ocr_status": "ocr"}}

    import_images(existing, {}, [image])
    assert calls == []

    import_images(existing, {}, [image], force_ocr=True)
    assert calls == [image]
    assert (ocr_dir / f"{image.stem}.txt").read_text(encoding="utf-8") == "Body Composition Analysis"


def test_validation_rejects_duplicate_sources_and_unknown_overrides(tmp_path):
    with pytest.raises(ValueError, match="source_file duplicato"):
        validate_records(
            [{"source_file": "same.png"}, {"source_file": "same.png"}],
            tmp_path / "measurements.json",
        )

    with pytest.raises(ValueError, match="campi non modificabili o sconosciuti"):
        validate_overrides({"report.png": {"source_file": "other.png"}}, tmp_path / "overrides.json")

    with pytest.raises(ValueError, match="valore fuori intervallo"):
        validate_records(
            [{"source_file": "report.png", "segment_fat_kg": {"right_arm": -0.1}}],
            tmp_path / "measurements.json",
        )


def test_validation_rejects_orphan_override(tmp_path):
    with pytest.raises(ValueError, match="override senza referto corrispondente"):
        validate_override_sources({"missing.png": {}}, {"known.png"}, tmp_path / "overrides.json")


def test_dashboard_json_escapes_script_terminators(tmp_path, monkeypatch):
    dashboard_path = tmp_path / "dashboard.html"
    monkeypatch.setattr("parse_scans.DASHBOARD_PATH", dashboard_path)
    write_dashboard([{"source_file": "</script><script>alert(1)</script>"}])
    content = dashboard_path.read_text(encoding="utf-8")
    assert "</script><script>alert(1)" not in content
    assert r"\u003c/script\u003e" in content
