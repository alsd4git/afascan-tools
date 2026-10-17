import json
from pathlib import Path

import pytest

from parse_scans import extract_record, tidy

FIXTURES = Path(__file__).parent / "fixtures"
CASES = [
    ("standard-report", "Screenshot_20260830-101500.png"),
    ("noisy-report", "Screenshot_20260831-113000.png"),
    ("incomplete-report", "Screenshot_20260901-090000.png"),
]


@pytest.mark.parametrize(("fixture", "source_file"), CASES)
def test_shared_parser_fixture(fixture: str, source_file: str):
    text = (FIXTURES / f"{fixture}.txt").read_text(encoding="utf-8")
    expected = json.loads((FIXTURES / f"{fixture}.expected.json").read_text(encoding="utf-8"))
    assert extract_record(Path(source_file), text) == expected


def test_incomplete_fixture_still_requires_review():
    text = (FIXTURES / "incomplete-report.txt").read_text(encoding="utf-8")
    record = extract_record(Path("Screenshot_20260901-090000.png"), text)
    assert tidy([record])[0]["review_required"] is True
