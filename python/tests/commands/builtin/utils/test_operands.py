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

from mirage.commands.builtin.utils.operands import (materialized_read,
                                                    merge_split_errors,
                                                    normalized_read,
                                                    operands_io, read_operands,
                                                    split_readable)
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, PathSpec


def _stat_over(files: dict[str, bytes], dirs: set[str] | None = None):
    typed = dirs or set()

    async def stat(path):
        if path.virtual in typed:
            return FileStat(name=path.virtual, type=FileType.DIRECTORY)
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        return FileStat(name=path.virtual, size=len(files[path.virtual]))

    return stat


def _read_over(files: dict[str, bytes]):

    async def read(path):
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        yield files[path.virtual]

    return read


@pytest.mark.asyncio
async def test_split_readable_keeps_order_and_reports_missing():
    paths = [
        PathSpec.from_str_path("/m1.txt"),
        PathSpec.from_str_path("/f.txt"),
        PathSpec.from_str_path("/m2.txt"),
    ]
    good, err = await split_readable(paths, _stat_over({"/f.txt": b"x"}),
                                     "cat")
    assert [p.virtual for p in good] == ["/f.txt"]
    assert err == (b"cat: /m1.txt: No such file or directory\n"
                   b"cat: /m2.txt: No such file or directory\n")


@pytest.mark.asyncio
async def test_split_readable_reports_stat_typed_dir_as_eisdir():
    good, err = await split_readable([PathSpec.from_str_path("/sub")],
                                     _stat_over({}, dirs={"/sub"}), "head")
    assert good == []
    assert err == b"head: /sub: Is a directory\n"


@pytest.mark.asyncio
async def test_split_readable_all_good_no_stderr():
    paths = [PathSpec.from_str_path("/f.txt")]
    good, err = await split_readable(paths, _stat_over({"/f.txt": b"x"}),
                                     "head")
    assert [p.virtual for p in good] == ["/f.txt"]
    assert err == b""


@pytest.mark.asyncio
async def test_split_readable_propagates_non_fs_errors():

    async def stat(path):
        raise RuntimeError("backend broke")

    with pytest.raises(RuntimeError):
        await split_readable([PathSpec.from_str_path("/f.txt")], stat, "cat")


@pytest.mark.asyncio
async def test_read_operands_reports_and_continues():
    files = {"/a.txt": b"aa", "/c.txt": b"cc"}
    paths = [
        PathSpec.from_str_path("/a.txt"),
        PathSpec.from_str_path("/b.txt"),
        PathSpec.from_str_path("/c.txt"),
    ]
    ok, err = await read_operands(paths, _read_over(files), "md5sum")
    assert [(o.path.virtual, o.data) for o in ok] == [("/a.txt", b"aa"),
                                                      ("/c.txt", b"cc")]
    assert err == b"md5sum: /b.txt: No such file or directory\n"


@pytest.mark.asyncio
async def test_read_operands_propagates_non_fs_errors():

    async def read(path):
        raise RuntimeError("boom")
        yield b""

    with pytest.raises(RuntimeError):
        await read_operands([PathSpec.from_str_path("/f")], read, "wc")


def test_operands_io_exit_codes():
    assert operands_io(b"").exit_code == 0
    assert operands_io(b"").stderr is None
    failed = operands_io(b"cat: /x: No such file or directory\n")
    assert failed.exit_code == 1
    assert failed.stderr == b"cat: /x: No such file or directory\n"
    cached = operands_io(b"", cache=["/a"])
    assert cached.cache == ["/a"]


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
