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

from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.generic.rg import parse_flags
from mirage.commands.builtin.rg_search import RgFlags, Tally
from mirage.commands.builtin.rg_stream import (
    SearchHints,
    open_rg,
    required_terms,
    search_input,
)
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue


def _flags(**flags: FlagValue) -> RgFlags:
    return parse_flags(FlagView(flags, spec=SPECS["rg"]))


@pytest.mark.parametrize(
    "pattern, flags, want",
    [
        ("needle", {}, SearchHints(["needle"], False, False)),
        (
            "needle",
            {"word_regexp": True},
            SearchHints(["needle"], True, False),
        ),
        ("n.*e", {}, None),
    ],
)
def test_compiled_terms_describe_safe_backend_candidates(
    pattern: str, flags: dict[str, FlagValue], want: SearchHints | None
) -> None:
    program = open_rg(pattern, False, _flags(**flags))
    assert required_terms(program) == want


def test_invalid_native_pattern_is_a_usage_error() -> None:
    with pytest.raises(UsageError):
        open_rg("(", False, _flags())


@pytest.mark.asyncio
async def test_streaming_preserves_byte_offsets_and_settles_counts() -> None:
    data = b"x" * 65535 + "é needle\nneedle\n".encode()
    f = _flags(
        only_matching=True,
        byte_offset=True,
        line_number=True,
        text=True,
        stats=True,
    )
    program = open_rg("needle", False, f)
    tally = Tally()

    async def source() -> AsyncIterator[bytes]:
        yield data[:65536]
        yield data[65536:]

    chunks = [
        chunk
        async for chunk in search_input(source(), program, f, "f", None, tally)
    ]
    assert b"".join(chunks) == b"1:65538:needle\n2:65545:needle\n"
    assert tally == Tally(
        selected=True, matches=2, matched_lines=2, searched=len(data)
    )


@pytest.mark.asyncio
async def test_quiet_match_closes_source_before_the_next_chunk() -> None:
    f = _flags(quiet=True, text=True)
    program = open_rg("needle", False, f)
    tally = Tally()
    closed = False
    reads = 0

    async def source() -> AsyncIterator[bytes]:
        nonlocal closed, reads
        try:
            reads += 1
            yield b"needle\n"
            reads += 1
            raise AssertionError("read beyond the selected record")
        finally:
            closed = True

    chunks = [
        chunk
        async for chunk in search_input(source(), program, f, "f", None, tally)
    ]
    assert b"".join(chunks) == b""
    assert tally.selected
    assert reads == 1
    assert closed


@pytest.mark.parametrize("quiet", [False, True])
@pytest.mark.asyncio
async def test_unused_capture_groups_do_not_block_an_ordinary_search(
    quiet: bool,
) -> None:
    f = _flags(line_regexp=True, quiet=quiet, text=True)
    program = open_rg("(a)" * 10000, False, f)
    tally = Tally()
    data = b"a" * 10000 + b"\n"

    async def source() -> AsyncIterator[bytes]:
        yield data

    chunks = [
        chunk
        async for chunk in search_input(source(), program, f, "f", None, tally)
    ]
    assert b"".join(chunks) == (b"" if quiet else data)
    assert tally.selected


def test_capture_memory_refusal_is_a_usage_error() -> None:
    with pytest.raises(UsageError, match="working memory"):
        open_rg("(a)" * 10000, False, _flags(replace="$1"))
