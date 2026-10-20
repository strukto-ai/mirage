from dataclasses import FrozenInstanceError

import pytest

from mirage.rs.diff_types import DiffOptions, PairResult


@pytest.mark.parametrize(
    ("value", "field", "replacement"),
    [
        (DiffOptions(), "ignore_case", True),
        (DiffOptions(mode="unified", context=1), "context", 3),
        (PairResult("equal", (), 0, ()), "status", 1),
        (
            PairResult("different", (b"1d0\n< a\n",), 1, ()),
            "output",
            (),
        ),
    ],
)
def test_shared_comparison_requests_and_results_cannot_be_changed(
    value, field, replacement
):
    with pytest.raises(FrozenInstanceError):
        setattr(value, field, replacement)
