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

import gc
from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.utils.operands import (
    materialized_read,
    merge_split_errors,
    normalized_read,
    operands_io,
    split_readable,
)
from mirage.io.stream import close_quietly
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, PathSpec


def _stat_over(files: dict[str, bytes], dirs: set[str] | None = None):
    typed = dirs or set()

    async def stat(path):
        if path.virtual in typed:
            return FileStat(name=path.virtual, type=FileType.DIRECTORY)
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        return FileStat(
            type=FileType.FILE,
            name=path.virtual,
            size=len(files[path.virtual]),
        )

    return stat


@pytest.mark.asyncio
async def test_normalized_read_defers_coroutines_for_unused_operands():
    read = AsyncMock(return_value=b"first\n")
    stream = normalized_read(read)
    path = PathSpec.from_str_path("/input")
    unused = stream(path)
    await close_quietly(unused)
    read.assert_not_called()
    assert [part async for part in stream(path)] == [b"first\n"]
    read.assert_awaited_once_with(path)


@pytest.mark.asyncio
async def test_normalized_read_closes_an_awaited_producer():
    closed = []

    async def producer():
        try:
            yield b"first\n"
            raise AssertionError("consumer fetched the tail")
        finally:
            closed.append(True)

    read = AsyncMock(return_value=producer())
    output = normalized_read(read)(PathSpec.from_str_path("/input"))
    assert await anext(output) == b"first\n"
    await close_quietly(output)
    assert closed == [True]


@pytest.mark.asyncio
async def test_split_readable_keeps_order_and_reports_missing():
    paths = [
        PathSpec.from_str_path("/m1.txt"),
        PathSpec.from_str_path("/f.txt"),
        PathSpec.from_str_path("/m2.txt"),
    ]
    good, err = await split_readable(
        paths, _stat_over({"/f.txt": b"x"}), "cat"
    )
    assert [p.virtual for p in good] == ["/f.txt"]
    assert err == (
        b"cat: /m1.txt: No such file or directory\n"
        b"cat: /m2.txt: No such file or directory\n"
    )


@pytest.mark.asyncio
async def test_split_readable_frees_a_failure_without_the_collector():
    gc.collect()
    gc.set_debug(gc.DEBUG_SAVEALL)
    try:
        await split_readable(
            [PathSpec.from_str_path("/m.txt")], _stat_over({}), "cat"
        )
        gc.collect()
        assert [e for e in gc.garbage if isinstance(e, OSError)] == []
    finally:
        gc.set_debug(0)
        gc.garbage.clear()


@pytest.mark.asyncio
async def test_split_readable_reports_stat_typed_dir_as_eisdir():
    good, err = await split_readable(
        [PathSpec.from_str_path("/sub")], _stat_over({}, dirs={"/sub"}), "head"
    )
    assert good == []
    assert err == b"head: error reading '/sub': Is a directory\n"


@pytest.mark.asyncio
async def test_split_readable_all_good_no_stderr():
    paths = [PathSpec.from_str_path("/f.txt")]
    good, err = await split_readable(
        paths, _stat_over({"/f.txt": b"x"}), "head"
    )
    assert [p.virtual for p in good] == ["/f.txt"]
    assert err == b""


@pytest.mark.asyncio
async def test_split_readable_propagates_non_fs_errors():
    async def stat(path):
        raise RuntimeError("backend broke")

    with pytest.raises(RuntimeError):
        await split_readable([PathSpec.from_str_path("/f.txt")], stat, "cat")


def test_operands_io_exit_codes():
    assert operands_io(b"").exit_code == 0
    assert operands_io(b"").stderr is None
    failed = operands_io(b"cat: /x: No such file or directory\n")
    assert failed.exit_code == 1
    assert failed.stderr == b"cat: /x: No such file or directory\n"


@pytest.mark.asyncio
async def test_merge_split_errors_attaches_and_flips_exit():
    out, io = await merge_split_errors((b"body", IOResult()), b"cat: x\n")
    assert out == b"body"
    assert io.exit_code == 1
    assert io.stderr == b"cat: x\n"
    out, io = await merge_split_errors((b"body", IOResult()), b"")
    assert io.exit_code == 0
    assert io.stderr is None


@pytest.mark.asyncio
async def test_merge_split_errors_appends_after_existing_stderr():
    existing = IOResult(stderr=b"warn\n")
    _, io = await merge_split_errors((None, existing), b"cat: x\n")
    assert io.stderr == b"warn\ncat: x\n"
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_normalized_read_accepts_bytes_awaitable_and_stream():
    async def gives_bytes(path):
        return b"bytes"

    async def gives_stream(path):
        yield b"st"
        yield b"ream"

    p = PathSpec.from_str_path("/f")
    read = normalized_read(gives_bytes)
    assert [c async for c in read(p)] == [b"bytes"]
    read = normalized_read(gives_stream)
    assert [c async for c in read(p)] == [b"st", b"ream"]


@pytest.mark.asyncio
async def test_materialized_read_accepts_bytes_awaitable_and_stream():
    async def gives_bytes(path):
        return b"bytes"

    async def gives_stream(path):
        yield b"st"
        yield b"ream"

    p = PathSpec.from_str_path("/f")
    assert await materialized_read(gives_bytes)(p) == b"bytes"
    assert await materialized_read(gives_stream)(p) == b"stream"
