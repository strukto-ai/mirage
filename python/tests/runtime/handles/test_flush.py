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

from mirage.runtime.handles.flush import plan_flush
from mirage.runtime.handles.types import FlushStep


def _plan(**over):
    facts = {
        "fresh": False,
        "base_len": 3,
        "runs": [],
        "cut": None,
        "size": 3,
        "appending": False,
    }
    return plan_flush(**{**facts, **over})


def test_a_created_file_goes_whole_with_its_gaps():
    assert _plan(
        fresh=True, base_len=0, runs=[(0, b"ab"), (3, b"c")], size=4
    ) == [FlushStep("write", data=b"ab\0c")]


def test_a_range_at_the_end_goes_as_an_append():
    assert _plan(runs=[(3, b"XYZ")], size=6) == [
        FlushStep("append", data=b"XYZ")
    ]


def test_an_append_mode_handle_appends_even_to_an_empty_file():
    assert _plan(base_len=0, runs=[(0, b"x")], size=1, appending=True) == [
        FlushStep("append", data=b"x")
    ]


def test_edits_go_as_pwrites_in_order():
    assert _plan(runs=[(0, b"a"), (2, b"c")]) == [
        FlushStep("pwrite", data=b"a", offset=0),
        FlushStep("pwrite", data=b"c", offset=2),
    ]


def test_a_cut_comes_first_and_growth_last():
    assert _plan(base_len=6, cut=2, runs=[(4, b"z")], size=8) == [
        FlushStep("truncate", length=2),
        FlushStep("pwrite", data=b"z", offset=4),
        FlushStep("truncate", length=8),
    ]


def test_growth_alone_is_one_truncate():
    assert _plan(size=5) == [FlushStep("truncate", length=5)]
