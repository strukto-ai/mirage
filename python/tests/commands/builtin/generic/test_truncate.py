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

from mirage.commands.builtin.generic.truncate import (
    Size,
    TruncateFlags,
    parse_flags,
    resolve_size,
    truncate_generic,
)
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, PathSpec


def _resolved(raw: str, current: int) -> int:
    parsed = parse_flags({"size": raw})
    assert isinstance(parsed, TruncateFlags)
    return resolve_size(parsed.size, current)


@pytest.mark.parametrize(
    "raw,current,size",
    [
        ("10", 0, 10),
        ("%4", 10, 12),
        ("/ 4", 10, 8),
        ("< 4", 10, 4),
        (">50", 10, 50),
        (" +2", 10, 12),
        ("-20", 10, 0),
        ("1KiB", 0, 1024),
        ("9007199254740993", 0, 9007199254740993),
    ],
)
def test_a_size_resolves_against_the_current_one(raw, current, size):
    assert _resolved(raw, current) == size


@pytest.mark.parametrize(
    "flags,stderr",
    [
        ({"size": "<abc"}, b"truncate: Invalid number: 'abc'\n"),
        ({"size": "/0"}, b"truncate: division by zero\n"),
        (
            {},
            b"truncate: you must specify either '--size' or '--reference'\n"
            b"Try 'truncate --help' for more information.\n",
        ),
    ],
)
def test_a_refused_size_is_the_result(flags, stderr):
    parsed = parse_flags(flags)
    assert isinstance(parsed, IOResult)
    assert (parsed.exit_code, parsed.stderr) == (1, stderr)


def _operand(path: str, raw: str) -> PathSpec:
    return PathSpec(
        virtual=path, directory="/", vfs_path=path.strip("/"), raw_path=raw
    )


@pytest.mark.asyncio
async def test_a_slashed_operand_is_the_opens_eisdir():
    # GNU opens with O_CREAT before it stats, so `missing/` and `reg/` are
    # the open's EISDIR, not the stat's miss, and an absent bare name is
    # made where its directory exists. The EISDIR is settled before the
    # op, so a backend with no truncate op says it too. The chain answers
    # first: under an absent directory the name is ENOENT and the op never
    # runs, every operand is still tried, and -c leaves an absent name
    # alone.
    lengths: list[tuple[str, int]] = []

    async def stat(path):
        raise FileNotFoundError(path.virtual)

    async def truncate_fn(path, length, no_create) -> None:
        lengths.append((path.raw_path, length))

    _, io = await truncate_generic(
        [
            _operand("/missing", "/missing/"),
            _operand("/nodir/x", "/nodir/x"),
            _operand("/missing", "/missing"),
        ],
        flags=TruncateFlags(size=Size("absolute", 4), no_create=False),
        stat=stat,
        truncate_fn=truncate_fn,
    )
    assert lengths == [("/missing", 4)]
    assert io.exit_code == 1
    assert io.stderr == (
        b"truncate: cannot open '/missing/' for writing: Is a directory\n"
        b"truncate: cannot open '/nodir/x' for writing: "
        b"No such file or directory\n"
    )
    _, io = await truncate_generic(
        [_operand("/missing", "/missing")],
        flags=TruncateFlags(size=Size("absolute", 4), no_create=True),
        stat=stat,
        truncate_fn=truncate_fn,
    )
    assert io.exit_code == 0
    assert lengths == [("/missing", 4)]


@pytest.mark.asyncio
async def test_no_create_reaches_the_mutation_after_a_successful_stat():
    calls = []

    async def stat(path):
        calls.append("stat")
        return FileStat(name=path.virtual, type=FileType.FILE, size=4)

    async def mutate(path, length, no_create):
        calls.append((path.virtual, length, no_create))

    _, result = await truncate_generic(
        [PathSpec.from_str_path("/file")],
        flags=TruncateFlags(Size("absolute", 2), True),
        stat=stat,
        truncate_fn=mutate,
    )
    assert result.exit_code == 0
    assert calls == ["stat", ("/file", 2, True)]
