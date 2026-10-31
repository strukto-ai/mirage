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
import asyncio

import pytest

from mirage.commands.builtin.constants import UINTMAX
from mirage.commands.builtin.generic.shuf import (
    MAX_OUTPUT_LINES,
    MEMORY_EXHAUSTED,
    NO_WRITE_OP,
    emit_count,
    parse_flags,
    shuf_generic,
)
from mirage.io.types import IOResult, materialize
from mirage.types import PathSpec
from tests.commands.builtin.conftest import output_bytes as _bytes
from tests.commands.builtin.conftest import ram_workspace as _ws
from tests.commands.builtin.conftest import run_raw as _run_raw


def test_shuf_e():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "shuf -e a b c", cwd="/data")
    lines = _bytes(stdout).strip().decode().split("\n")
    assert len(lines) == 3
    assert sorted(lines) == sorted(["/a", "/b", "/c"])


def test_shuf_n():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "shuf -e -n 2 a b c d e", cwd="/data")
    lines = _bytes(stdout).strip().decode().split("\n")
    assert len(lines) == 2


def test_shuf_r():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "shuf -r -e -n 5 a b c", cwd="/data")
    lines = _bytes(stdout).strip().decode().split("\n")
    assert len(lines) == 5


def test_shuf_ends_a_files_last_record_at_that_file():
    ws, _ = _ws()
    _run_raw(ws, "printf a > a; printf 'b\\n' > b", cwd="/data")
    stdout, io = _run_raw(ws, "shuf a b | sort", cwd="/data")
    assert io.exit_code == 0
    assert _bytes(stdout) == b"a\nb\n"


async def _unused_read_bytes(_path):
    raise AssertionError("read_bytes should not be called for -i")


@pytest.mark.parametrize("raw", ["abc", "2x"])
def test_shuf_head_count_refusal_quotes_the_whole_argument(raw):
    """GNU quotes all of `-n 2x`, unlike expand and cut."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, f"shuf -e -n {raw} a b c", cwd="/data")
    assert io.exit_code == 1
    assert io.stderr == f"shuf: invalid line count: '{raw}'\n".encode()
    assert not stdout


def _refusal(flags):
    """The stderr ``parse_flags`` refuses ``flags`` with, at exit 1."""
    parsed = parse_flags(flags)
    assert isinstance(parsed, IOResult)
    assert parsed.exit_code == 1
    return parsed.stderr


@pytest.mark.parametrize(
    "flags,stderr",
    [
        ({"head_count": " 5 "}, b"shuf: invalid line count: ' 5 '\n"),
        ({"head_count": "-1"}, b"shuf: invalid line count: '-1'\n"),
        ({"head_count": "2\n"}, b"shuf: invalid line count: '2\\n'\n"),
        ({"input_range": "3-1"}, b"shuf: invalid input range: '3-1'\n"),
        ({"input_range": "1-3\n"}, b"shuf: invalid input range: '1-3\\n'\n"),
        (
            {"input_range": f"1-{UINTMAX + 1}"},
            (
                f"shuf: invalid input range: '1-{UINTMAX + 1}': "
                "Value too large for defined data type\n"
            ).encode(),
        ),
    ],
)
def test_shuf_refuses_a_value_before_any_operand(flags, stderr):
    assert _refusal(flags) == stderr


@pytest.mark.parametrize(
    "flags,count,bounds",
    [
        ({"head_count": "05"}, 5, None),
        ({"head_count": " +2"}, 2, None),
        ({"head_count": "9" * 400}, UINTMAX, None),
        ({"head_count": ["3", "1", "2"]}, 1, None),
        ({"input_range": " 1- 3"}, None, (1, 3)),
        ({"input_range": f"0-{UINTMAX - 1}"}, None, (0, UINTMAX - 1)),
    ],
)
def test_shuf_reads_the_least_count_and_exact_bounds(flags, count, bounds):
    """GNU keeps the least ``-n`` typed, clamped to SIZE_MAX, and a bound
    past 2**53 stays exact."""
    parsed = parse_flags(flags)
    assert not isinstance(parsed, IOResult)
    assert parsed.count == count
    assert parsed.input_range == bounds


def test_shuf_head_count_zero_prints_nothing():
    """GNU `shuf -n 0` succeeds with zero bytes, not one bare separator."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "shuf -e -n 0 a b c", cwd="/data")
    assert io.exit_code == 0
    assert _bytes(stdout) == b""


def test_shuf_head_count_one_still_works():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "shuf -e -n 1 a b c", cwd="/data")
    assert io.exit_code == 0
    assert len(_bytes(stdout).strip().decode().split("\n")) == 1


def test_shuf_input_range_single_element_is_valid():
    """GNU `-i 2-2` is a one-element range, not a degenerate one."""
    rendered, io = asyncio.run(
        shuf_generic([], [], read=_unused_read_bytes, input_range=(2, 2))
    )
    assert io.exit_code == 0
    rendered = asyncio.run(materialize(rendered))
    assert rendered == b"2\n"


def test_shuf_input_range_stays_valid():
    rendered, io = asyncio.run(
        shuf_generic([], [], read=_unused_read_bytes, input_range=(1, 3))
    )
    assert io.exit_code == 0
    rendered = asyncio.run(materialize(rendered))
    assert sorted(rendered.decode().strip().split("\n")) == ["1", "2", "3"]


def test_shuf_builder_returns_a_refusal_rather_than_raising():
    ws, _ = _ws()
    for cmd, message in [
        ("shuf -n abc", b"shuf: invalid line count: 'abc'\n"),
        ("shuf -i 1-x", b"shuf: invalid input range: '1-x'\n"),
    ]:
        stdout, io = _run_raw(ws, cmd, stdin=b"a\n")
        assert io.exit_code == 1
        assert not _bytes(stdout)
        assert io.stderr == message


def test_shuf_no_write_op_is_not_swallowed_by_that_catch():
    """The one ValueError the builder must let through.

    A `-o` on a backend with no write op is a wiring fault, and the
    TypeScript twin throws a bare Error for it where it returns an
    IOResult for every user-facing refusal. Named as a constant so the
    catch and the raise cannot drift apart.
    """
    assert NO_WRITE_OP == "shuf: backend provides no write op"
    with pytest.raises(ValueError, match="backend provides no write op"):
        asyncio.run(
            shuf_generic(
                [],
                [],
                read=_unused_read_bytes,
                stdin=b"a\n",
                output=PathSpec(
                    vfs_path="o.txt",
                    virtual="/o.txt",
                    directory="/",
                    resolved=True,
                ),
                write_bytes=None,
            )
        )


# The reviewed bug, and the one shape that proves the bounds are exact rather
# than merely wide: read as float64, `9007199254740992` (2**53) increments to
# itself so this never terminates, and `9007199254740993` parses to 2**53 and
# prints the WRONG integer with exit 0 (ground truth SH2). Both are
# one-element ranges, so the assertion is on the byte, and neither can hang
# the suite even if the fix regresses in some other direction.
@pytest.mark.parametrize(
    "low",
    [
        2**53,
        2**53 + 1,
        2**63 - 1,
        2**63,
        UINTMAX,
    ],
)
def test_shuf_input_range_emits_a_large_bound_exactly(low):
    rendered, io = asyncio.run(
        shuf_generic([], [], read=_unused_read_bytes, input_range=(low, low))
    )
    assert io.exit_code == 0
    rendered = asyncio.run(materialize(rendered))
    assert rendered == f"{low}\n".encode()


# GNU never builds the population when `-n` is below the element count, which
# is why `shuf -i 1-18446744073709551615 -n 3` answers instantly (ground truth
# SH5). Each case here names a range far too large to enumerate, so an
# implementation that enumerates fails by timing out rather than by assertion
# -- which is exactly the failure the reviewer reported.
@pytest.mark.parametrize(
    "low,high",
    [(1, UINTMAX), (1, 1000000000000), (1, 100000000)],
)
def test_shuf_samples_a_huge_range_without_enumerating_it(low, high):
    rendered, io = asyncio.run(
        shuf_generic(
            [], [], read=_unused_read_bytes, input_range=(low, high), count=3
        )
    )
    assert io.exit_code == 0
    rendered = asyncio.run(materialize(rendered))
    values = [int(line) for line in rendered.decode().split("\n")[:-1]]
    assert len(values) == 3
    assert len(set(values)) == 3
    assert all(low <= value <= high for value in values)


def test_shuf_head_count_zero_on_a_huge_range_emits_nothing():
    """GNU answers `-n 0` instantly however large the range is."""
    rendered, io = asyncio.run(
        shuf_generic(
            [],
            [],
            read=_unused_read_bytes,
            input_range=(1, UINTMAX),
            count=0,
        )
    )
    assert io.exit_code == 0
    rendered = asyncio.run(materialize(rendered))
    assert rendered == b""


def test_shuf_repeat_draws_from_a_huge_range_without_enumerating_it():
    rendered, io = asyncio.run(
        shuf_generic(
            [],
            [],
            read=_unused_read_bytes,
            input_range=(1, UINTMAX),
            count=4,
            with_replacement=True,
        )
    )
    assert io.exit_code == 0
    rendered = asyncio.run(materialize(rendered))
    assert len(rendered.decode().split("\n")[:-1]) == 4


# A range GNU would enumerate given enough memory, and the wording is GNU's
# own `xalloc_die` line for exactly that situation (ground truth SH5). mirage
# renders one byte object rather than streaming, so the ceiling is stated
# rather than left to whatever the host survives.
@pytest.mark.parametrize(
    "kwargs",
    [
        {"input_range": (1, UINTMAX)},
        {"input_range": (1, 1000000000000)},
        {"input_range": (1, MAX_OUTPUT_LINES + 1)},
        {"input_range": (1, UINTMAX), "with_replacement": True},
        {
            "input_range": (1, 3),
            "count": MAX_OUTPUT_LINES + 1,
            "with_replacement": True,
        },
    ],
)
def test_shuf_refuses_an_output_it_cannot_render(kwargs):
    with pytest.raises(ValueError) as refusal:
        asyncio.run(shuf_generic([], [], read=_unused_read_bytes, **kwargs))
    assert str(refusal.value) == MEMORY_EXHAUSTED
    assert MEMORY_EXHAUSTED == "shuf: memory exhausted"


def test_shuf_repeat_with_a_huge_count_on_stdin_is_refused_too():
    """The same ceiling, reached through `-r -n` rather than through `-i`.

    Without `-r` a `-n` past the input's line count is just a head count
    and emits every line, which is why the second half exits 0.
    """
    with pytest.raises(ValueError) as refusal:
        asyncio.run(
            shuf_generic(
                [],
                [],
                read=_unused_read_bytes,
                stdin=b"a\n",
                count=MAX_OUTPUT_LINES + 1,
                with_replacement=True,
            )
        )
    assert str(refusal.value) == MEMORY_EXHAUSTED
    rendered, io = asyncio.run(
        shuf_generic(
            [],
            [],
            read=_unused_read_bytes,
            stdin=b"a\nb\n",
            count=MAX_OUTPUT_LINES + 1,
        )
    )
    assert io.exit_code == 0
    assert sorted(
        asyncio.run(materialize(rendered)).decode().split("\n")[:-1]
    ) == ["a", "b"]


# `emit_count` is what lets the range path sample rather than enumerate, so it
# is pinned on its own: `-r` emits exactly the count it was asked for however
# few values it draws from, while a head count cannot exceed what is there.
@pytest.mark.parametrize(
    "available,count,repeat,expected",
    [
        (3, None, False, 3),
        (3, 5, False, 3),
        (3, 2, False, 2),
        (3, 0, False, 0),
        (3, None, True, 3),
        (3, 5, True, 5),
        (1, 7, True, 7),
        (0, 5, True, 0),
        (0, None, True, 0),
        (0, 5, False, 0),
        (2**64 - 1, 3, False, 3),
        (2**64 - 1, None, False, 2**64 - 1),
    ],
)
def test_shuf_emit_count_is_decided_before_anything_is_built(
    available, count, repeat, expected
):
    assert emit_count(available, count, repeat) == expected


def test_shuf_memory_exhausted_is_a_refusal_the_builder_renders():
    """The builder turns it into one stderr line and exit 1, as GNU does."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, f"shuf -i 1-{UINTMAX}", stdin=b"a\n")
    assert io.exit_code == 1
    assert not _bytes(stdout)
    assert io.stderr == b"shuf: memory exhausted\n"


def test_shuf_input_range_overflow_reaches_the_shell_with_its_clause():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "shuf -i 1-18446744073709551616", stdin=b"a\n")
    assert io.exit_code == 1
    assert not _bytes(stdout)
    assert io.stderr == (
        b"shuf: invalid input range: '1-18446744073709551616'"
        b": Value too large for defined data type\n"
    )


# GNU validates options as getopt hands them over, so the first bad one on
# the line speaks, and a repeated -i or a second, different -o is its own
# refusal. Measured on coreutils 9.7; mirrored in shuf.test.ts.
@pytest.mark.parametrize(
    "line,stderr",
    [
        ("shuf -i 1-x -n abc", "shuf: invalid input range: '1-x'\n"),
        ("shuf -n abc -i 1-x", "shuf: invalid line count: 'abc'\n"),
        ("shuf -i 1-2 -i 3-4", "shuf: multiple -i options specified\n"),
        ("shuf -i 1-2 -i 1-2", "shuf: multiple -i options specified\n"),
        ("shuf -i 1-x -i 2-3", "shuf: invalid input range: '1-x'\n"),
        ("shuf -i 1-2 -n abc -i 3-4", "shuf: invalid line count: 'abc'\n"),
        (
            "shuf -i 1-2 -o ./a -o a",
            "shuf: multiple output files specified\n",
        ),
        (
            "shuf -i 1-2 -o /data/a -o /data/b",
            "shuf: multiple output files specified\n",
        ),
        (
            "shuf -e a -i 1-2",
            "shuf: cannot combine -e and -i options\n"
            "Try 'shuf --help' for more information.\n",
        ),
        (
            "shuf -i 1-2 /data/f",
            "shuf: extra operand '/data/f'\n"
            "Try 'shuf --help' for more information.\n",
        ),
    ],
)
def test_shuf_refuses_in_command_line_order(line, stderr):
    ws, _ = _ws()
    stdout, io = _run_raw(ws, line, cwd="/data")
    assert io.exit_code == 1
    assert io.stderr == stderr.encode()
    assert not stdout


def test_shuf_accepts_the_same_output_twice():
    ws, _ = _ws()
    _, io = _run_raw(ws, "shuf -i 1-1 -o /data/o -o /data/o", cwd="/data")
    assert io.exit_code == 0
    stdout, _ = _run_raw(ws, "cat /data/o")
    assert _bytes(stdout) == b"1\n"
