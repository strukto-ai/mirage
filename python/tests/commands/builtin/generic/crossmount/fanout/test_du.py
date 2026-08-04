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

from mirage.commands.builtin.generic.crossmount.fanout.du import du_total
from mirage.commands.builtin.generic.crossmount.types import OperandRun
from mirage.io import IOResult
from mirage.types import PathSpec


def _scope(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual[:virtual.rfind("/") + 1],
                    resource_path="",
                    resolved=True)


def _op(data: bytes, exit_code: int = 0) -> OperandRun:
    return OperandRun(_scope("/a/x"), data, IOResult(exit_code=exit_code))


def testdu_total_strips_per_run_totals_and_sums():
    runs = [
        _op(b"5\t/a/sub\n5\ttotal\n"),
        _op(b"3\t/b/c.txt\n3\ttotal\n"),
    ]
    out = du_total(runs, human=False).decode()
    assert out == "5\t/a/sub\n3\t/b/c.txt\n8\ttotal\n"


def testdu_total_humanizes_from_exact_bytes_without_rounding_twice():
    # run_fanout forces -h off on the native runs, so the rows arrive in
    # bytes: 1500 + 1500 is 2.9K, not the 3.0K that summing two "1.5K"
    # readings back through parse_size would give.
    runs = [
        _op(b"1500\t/a/x\n1500\ttotal\n"),
        _op(b"1500\t/b/z\n1500\ttotal\n"),
    ]
    out = du_total(runs, human=True).decode()
    assert out == "1.5K\t/a/x\n1.5K\t/b/z\n2.9K\ttotal\n"


def testdu_total_leaves_a_row_without_a_tab_alone():
    out = du_total([_op(b"odd-row\n0\ttotal\n")], human=True).decode()
    assert out == "odd-row\n0B\ttotal\n"
