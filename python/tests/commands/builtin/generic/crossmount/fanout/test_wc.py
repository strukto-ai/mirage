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


def testcombine_wc_keeps_every_row_of_a_glob_operand():
    # run_fanout forces --total=never, so a glob operand's run is all file
    # rows; the combine must not treat the last one as a per-run total.
    runs = [
        _op(b"2 /a/one.txt\n1 /a/two.txt\n"),
        _op(b"1 /b/three.txt\n"),
    ]
    out = combine_wc(runs, {"lines": True}).decode()
    assert out == ("2 /a/one.txt\n"
                   "1 /a/two.txt\n"
                   "1 /b/three.txt\n"
                   "4 total\n")


def testcombine_wc_max_line_length_maxes_instead_of_summing():
    runs = [_op(b"9 /a/x\n"), _op(b"4 /b/y\n")]
    out = combine_wc(runs, {"max_line_length": True}).decode()
    assert out.endswith("9 total\n")


def testcombine_wc_total_never_prints_no_total_row():
    runs = [_op(b"2 3 14 /a/x.txt\n"), _op(b"1 3 15 /b/z.txt\n")]
    out = combine_wc(runs, {"total": "never"}).decode()
    assert out == (" 2  3 14 /a/x.txt\n"
                   " 1  3 15 /b/z.txt\n")


def testcombine_wc_total_only_prints_the_grand_total_alone():
    runs = [_op(b"2 3 14 /a/x.txt\n"), _op(b"1 3 15 /b/z.txt\n")]
    out = combine_wc(runs, {"total": "only"}).decode()
    assert out == "3 6 29\n"


def testcombine_wc_total_always_prints_a_total_for_one_row():
    out = combine_wc([_op(b"2 3 14 /a/x.txt\n")], {"total": "always"}).decode()
    assert out == " 2  3 14 /a/x.txt\n 2  3 14 total\n"


def testcombine_wc_auto_omits_the_total_for_one_row():
    out = combine_wc([_op(b"2 3 14 /a/x.txt\n")], {}).decode()
    assert out == " 2  3 14 /a/x.txt\n"


def testcombine_wc_failed_operand_still_gets_a_total_row():
    # Two operands were given, so GNU prints the total even though only one
    # of them resolved into a row.
    runs = [_op(b"1 /a/f.txt\n"), _op(b"", exit_code=1)]
    out = combine_wc(runs, {"lines": True}).decode()
    assert out == "1 /a/f.txt\n1 total\n"


def testcombine_wc_all_operands_failed_prints_nothing():
    assert combine_wc([_op(b"", exit_code=1)], {}) == b""


def testcombine_wc_total_only_zeroes_when_every_operand_failed():
    out = combine_wc([_op(b"", exit_code=1)], {"total": "only"}).decode()
    assert out == "0 0 0\n"
