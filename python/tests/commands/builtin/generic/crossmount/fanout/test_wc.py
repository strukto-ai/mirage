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

from mirage.commands.builtin.generic.crossmount.fanout.wc import combine_wc
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


def testcombine_wc_uses_one_global_width():
    runs = [
        _op(b"100 100 400 /a/big.txt\n"),
        _op(b"5 5 20 /b/small.txt\n"),
    ]
    out = combine_wc(runs, {}).decode()
    assert out == ("100 100 400 /a/big.txt\n"
                   "  5   5  20 /b/small.txt\n"
                   "105 105 420 total\n")


def testcombine_wc_drops_per_run_totals_from_glob_operands():
    runs = [
        _op(b"2 /a/one.txt\n1 /a/two.txt\n3 total\n"),
        _op(b"1 /b/three.txt\n"),
    ]
    out = combine_wc(runs, {"args_l": True}).decode()
    assert out == ("2 /a/one.txt\n"
                   "1 /a/two.txt\n"
                   "1 /b/three.txt\n"
                   "4 total\n")


def testcombine_wc_max_line_length_maxes_instead_of_summing():
    runs = [_op(b"9 /a/x\n"), _op(b"4 /b/y\n")]
    out = combine_wc(runs, {"L": True}).decode()
    assert out.endswith("9 total\n")
