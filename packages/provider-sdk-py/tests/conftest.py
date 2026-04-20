"""Shared test fixtures and helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

FIXTURES_DIR = Path(__file__).resolve().parent.parent.parent.parent / "test" / "fixtures"

FIXTURE_NAMES = [
    "001-simple-insert",
    "002-multiple-inserts",
    "003-delete",
    "004-concurrent-edits",
    "005-large-document",
    "006-empty-document",
    "007-unicode",
    "008-rapid-edits",
    "009-replace-content",
    "010-with-initial-content",
]


def load_fixture(name: str) -> dict[str, Any]:
    path = FIXTURES_DIR / f"{name}.json"
    return json.loads(path.read_text())


@pytest.fixture(params=FIXTURE_NAMES)
def fixture_data(request: pytest.FixtureRequest) -> dict[str, Any]:
    return load_fixture(request.param)
