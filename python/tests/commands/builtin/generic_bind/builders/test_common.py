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

from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders.common import (
    dir_refusing_read, split_readable)
from mirage.types import FileStat, FileType, PathSpec


def _ops(missing: set[str],
         implicit_dirs: set[str] | None = None,
         explicit_dirs: set[str] | None = None) -> CommandIO:
    dirs = implicit_dirs or set()
    typed = explicit_dirs or set()

    async def stat(_accessor, path, _index):
        if path.virtual in missing or path.virtual in dirs:
            raise FileNotFoundError(path.virtual)
        if path.virtual in typed:
            return FileStat(name=path.virtual, type=FileType.DIRECTORY)
        return FileStat(name=path.virtual, size=0)

    async def readdir(_accessor, path, _index):
        target = path.virtual.rstrip("/") or "/"
        entries = [d for d in dirs if (d.rsplit("/", 1)[0] or "/") == target]
        if path.virtual in dirs:
            entries.append(path.virtual.rstrip("/") + "/child.txt")
        return entries

    async def read_stream(_accessor, _path, _index):
        yield b"data"

    async def unused(*_args):
        raise AssertionError("not used")

    return CommandIO(readdir=readdir,
                     read_bytes=unused,
                     read_stream=read_stream,
                     stat=stat,
                     is_mounted=lambda _a: True)


@pytest.mark.asyncio
async def test_split_readable_keeps_order_and_reports_missing():
    paths = [
        PathSpec.from_str_path("/m1.txt"),
        PathSpec.from_str_path("/f.txt"),
        PathSpec.from_str_path("/m2.txt"),
    ]
    good, err = await split_readable(_ops({"/m1.txt", "/m2.txt"}), None, paths,
                                     None, "cat")
    assert [p.virtual for p in good] == ["/f.txt"]
    assert err == (b"cat: /m1.txt: No such file or directory\n"
                   b"cat: /m2.txt: No such file or directory\n")


@pytest.mark.asyncio
async def test_split_readable_reports_implicit_dir_as_eisdir():
    ops = _ops(set(), implicit_dirs={"/sub"})
    good, err = await split_readable(ops, None,
                                     [PathSpec.from_str_path("/sub")], None,
                                     "cat")
    assert good == []
    assert err == b"cat: /sub: Is a directory\n"


@pytest.mark.asyncio
async def test_split_readable_ignores_fabricated_children():
    # Synthetic hierarchies (postgres schema level) answer a readdir of
    # any missing name with fabricated children; only the parent listing
    # decides, so the original ENOENT stands.

    async def stat(_accessor, path, _index):
        raise FileNotFoundError(path.virtual)

    async def readdir(_accessor, path, _index):
        target = path.virtual.rstrip("/") or "/"
        if target == "/":
            return ["/real.txt"]
        return [f"{target}/tables", f"{target}/views"]

    async def unused(*_args):
        raise AssertionError("not used")

    ops = CommandIO(readdir=readdir,
                    read_bytes=unused,
                    read_stream=unused,
                    stat=stat,
                    is_mounted=lambda _a: True)
    good, err = await split_readable(ops, None,
                                     [PathSpec.from_str_path("/nope.txt")],
                                     None, "cat")
    assert good == []
    assert err == b"cat: /nope.txt: No such file or directory\n"


@pytest.mark.asyncio
async def test_split_readable_probe_swallows_driver_errors():
    # A backend whose readdir raises a non-FS driver error for missing
    # names (lancedb: "Table ... was not found") must not leak it through
    # the probe; the original ENOENT stands.

    async def stat(_accessor, path, _index):
        raise FileNotFoundError(path.virtual)

    async def readdir(_accessor, path, _index):
        raise ValueError("Table 'nope.txt' was not found")

    async def unused(*_args):
        raise AssertionError("not used")

    ops = CommandIO(readdir=readdir,
                    read_bytes=unused,
                    read_stream=unused,
                    stat=stat,
                    is_mounted=lambda _a: True)
    good, err = await split_readable(ops, None,
                                     [PathSpec.from_str_path("/nope.txt")],
                                     None, "wc")
    assert good == []
    assert err == b"wc: /nope.txt: No such file or directory\n"


@pytest.mark.asyncio
async def test_split_readable_reports_stat_typed_dir_as_eisdir():
    ops = _ops(set(), explicit_dirs={"/sub"})
    good, err = await split_readable(ops, None,
                                     [PathSpec.from_str_path("/sub")], None,
                                     "head")
    assert good == []
    assert err == b"head: /sub: Is a directory\n"


@pytest.mark.asyncio
async def test_dir_refusing_read_raises_eisdir_for_dirs():
    ops = _ops(set(), implicit_dirs={"/sub"})
    read = dir_refusing_read(ops, None, None)
    with pytest.raises(IsADirectoryError):
        async for _ in read(PathSpec.from_str_path("/sub")):
            raise AssertionError("no data expected")


@pytest.mark.asyncio
async def test_dir_refusing_read_streams_files():
    ops = _ops(set())
    read = dir_refusing_read(ops, None, None)
    chunks = [c async for c in read(PathSpec.from_str_path("/f.txt"))]
    assert chunks == [b"data"]


@pytest.mark.asyncio
async def test_split_readable_all_good_no_stderr():
    paths = [PathSpec.from_str_path("/f.txt")]
    good, err = await split_readable(_ops(set()), None, paths, None, "head")
    assert [p.virtual for p in good] == ["/f.txt"]
    assert err == b""


@pytest.mark.asyncio
async def test_split_readable_propagates_non_fs_errors():

    async def stat(_accessor, _path, _index):
        raise RuntimeError("backend broke")

    async def unused(*_args):
        raise AssertionError("not used")

    ops = CommandIO(readdir=unused,
                    read_bytes=unused,
                    read_stream=unused,
                    stat=stat,
                    is_mounted=lambda _a: True)
    with pytest.raises(RuntimeError):
        await split_readable(ops, None, [PathSpec.from_str_path("/f.txt")],
                             None, "cat")
