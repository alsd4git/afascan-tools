from pathlib import Path

from parse_scans import extract_record, number, tidy


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


def test_body_composition_without_segment_overrides_requires_review():
    record = extract_record(
        Path("Screenshot_20260830-101500.png"),
        "Body Composition Analysis\n2026-08-30\nWeight (kg) 80.8",
    )

    assert tidy([record])[0]["review_required"] is True
