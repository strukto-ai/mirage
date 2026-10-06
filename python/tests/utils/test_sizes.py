# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import json
from pathlib import Path

import pytest

from mirage.types import FileStat, FileType
from mirage.utils.sizes import reported_size, upload_receipt

_FIXTURE = (
    Path(__file__).parents[3]
    / "integ"
    / "fixtures"
    / "sizes"
    / "reported_size.json"
)

_CASES = json.loads(_FIXTURE.read_text())["cases"]


def _value(case: dict):
    if "repeat" in case:
        return case["repeat"] * case["times"]
    return case["value"]


def test_the_shared_fixture_is_not_empty():
    # integ/fixtures/sizes/reported_size.json is the contract: the
    # TypeScript suite (packages/core/src/utils/sizes.test.ts) reads the
    # same rows, so an empty corpus would pass both vacuously.
    assert len(_CASES) > 0


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_reported_size_matches_the_shared_fixture(case):
    got = reported_size(_value(case))
    assert got == case["expected"]
    if case["expected"] is not None:
        # An int, never a float or a bool, so a stored size compares and
        # serializes the same as len(data).
        assert type(got) is int


def _stat(item: dict) -> FileStat:
    return FileStat(
        name="f.txt", type=FileType.FILE, fingerprint=item.get("token")
    )


def _raising(calls: list[dict]):
    def parse(item: dict) -> FileStat:
        calls.append(item)
        raise ValueError("bad reply")

    return parse


# (reply item, expected (bytes, token)) for 5 sent bytes.
_RECEIPT_ROWS = [
    ({"size": 5, "token": "t5"}, (5, "t5")),
    ({"size": 9, "token": "t5"}, (9, "t5")),
    ({"size": 5, "token": ""}, (5, None)),
    ({"token": "t5"}, (5, None)),
    ({"size": "x", "token": "t5"}, (5, None)),
    (None, (5, None)),
    ("not json", (5, None)),
    (["not", "a", "dict"], (5, None)),
]


@pytest.mark.parametrize(
    ("item", "expected"),
    _RECEIPT_ROWS,
    ids=[
        "agrees",
        "stored-size-differs",
        "empty-token",
        "token-without-size",
        "bad-size",
        "no-reply",
        "string-reply",
        "list-reply",
    ],
)
def test_upload_receipt_reads_size_and_token(item, expected):
    assert upload_receipt(item, _stat, 5, "/m/f.txt") == expected


@pytest.mark.parametrize("size", [5, 9], ids=["sent-size", "other-size"])
def test_a_failing_parser_keeps_the_size_and_drops_the_token(size):
    # The size still reaches the cache's size check, so a write stored at
    # another size is dropped rather than kept untokened.
    calls: list[dict] = []
    item = {"size": size, "token": "t"}
    assert upload_receipt(item, _raising(calls), 5, "/m/f.txt") == (
        size,
        None,
    )
    assert calls == [item]
