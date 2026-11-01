import json
from pathlib import Path
from typing import Any

import pytest

from mirage.rs.document import validate_document

CORPUS = Path(__file__).resolve().parents[3] / "integ/policy/documents.json"


@pytest.mark.parametrize(
    "case",
    json.loads(CORPUS.read_text())["cases"],
    ids=lambda case: case["id"],
)
def test_shared_document_corpus(case: dict[str, Any]) -> None:
    args = (case["op"], case["value"], case["where"])
    options = case.get("options", {})
    if "error" in case:
        with pytest.raises(ValueError) as raised:
            validate_document(*args, **options)
        assert case["error"] in str(raised.value)
    else:
        assert validate_document(*args, **options) == case["expect"]
