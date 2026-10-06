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

import pytest

from mirage.runtime.handles.flush import plan_flush
from mirage.runtime.handles.types import FlushStep


@pytest.mark.parametrize(
    ("facts", "steps"),
    [
        pytest.param(
            {"base_len": 0, "runs": [(0, b"ab"), (3, b"c")], "size": 4},
            [
                FlushStep("pwrite", data=b"ab", offset=0),
                FlushStep("pwrite", data=b"c", offset=3),
            ],
            id="a-created-file-sends-only-its-ranges",
        ),
        pytest.param(
            {"runs": [(3, b"XYZ")], "size": 6},
            [FlushStep("append", data=b"XYZ")],
            id="a-range-at-the-end-goes-as-an-append",
        ),
        pytest.param(
            {"base_len": 0, "runs": [(0, b"x")], "size": 1, "appending": True},
            [FlushStep("append", data=b"x")],
            id="an-append-mode-handle-appends-even-to-an-empty-file",
        ),
        pytest.param(
            {"runs": [(0, b"a"), (2, b"c")]},
            [
                FlushStep("pwrite", data=b"a", offset=0),
                FlushStep("pwrite", data=b"c", offset=2),
            ],
            id="edits-go-as-pwrites-in-order",
        ),
        pytest.param(
            {"base_len": 6, "cut": 2, "runs": [(4, b"z")], "size": 8},
            [
                FlushStep("truncate", length=2),
                FlushStep("pwrite", data=b"z", offset=4),
                FlushStep("truncate", length=8),
            ],
            id="a-cut-comes-first-and-growth-last",
        ),
        pytest.param(
            {"size": 5},
            [FlushStep("truncate", length=5)],
            id="growth-alone-is-one-truncate",
        ),
    ],
)
def test_plan_flush(facts, steps):
    base = {
        "base_len": 3,
        "runs": [],
        "cut": None,
        "size": 3,
        "appending": False,
    }
    assert plan_flush(**{**base, **facts}) == steps
