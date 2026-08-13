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

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.generic_bind.adapter import (CommandIO, Operation,
                                                          dir_aware_stat,
                                                          dir_aware_stream)
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES

TREE = {
    "/notion/pages": [
        "/notion/pages/Demo_page__uuid1",
        "/notion/pages/Roadmap__uuid2",
    ],
}


async def fake_readdir(accessor, path, index=None):
    key = path.virtual.rstrip("/") or "/"
    if key not in TREE:
        raise FileNotFoundError(key)
    return TREE[key]


def glob_spec(virtual: str, prefix: str) -> PathSpec:
    last_slash = virtual.rfind("/")
    return PathSpec(
        virtual=virtual,
        directory=virtual[:last_slash + 1],
        resource_path=virtual[len(prefix):].strip("/"),
        pattern=virtual[last_slash + 1:],
        resolved=False,
    )


def make_io(**kwargs) -> CommandIO:
    return CommandIO(readdir=fake_readdir,
                     read_bytes=fake_readdir,
                     read_stream=fake_readdir,
                     stat=fake_readdir,
                     is_mounted=lambda a: True,
                     **kwargs)


def test_command_io_default_glob_cap():
    assert make_io().max_glob_matches == DEFAULT_MAX_GLOB_MATCHES


@pytest.mark.asyncio
async def test_command_io_resolve_glob_binds_readdir():
    resolve = make_io().resolve_glob
    spec = glob_spec("/notion/pages/Demo*", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert [p.virtual for p in result] == ["/notion/pages/Demo_page__uuid1"]


@pytest.mark.asyncio
async def test_command_io_resolve_glob_honors_cap():
    resolve = make_io(max_glob_matches=1).resolve_glob
    spec = glob_spec("/notion/pages/*", "/notion")
    result = await resolve(NOOPAccessor(), [spec], None)
    assert len(result) == 1


def test_command_io_require_missing_op():
    io = make_io()
    with pytest.raises(NotImplementedError):
        io.require(Operation.WRITE)
    assert make_io(write=fake_readdir).require(Operation.WRITE) is fake_readdir


def _probe_ops(missing: set[str],
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
async def test_dir_aware_stat_refines_implicit_dir_to_eisdir():
    stat = dir_aware_stat(_probe_ops(set(), implicit_dirs={"/sub"}), None,
                          None)
    with pytest.raises(IsADirectoryError):
        await stat(PathSpec.from_str_path("/sub"))


@pytest.mark.asyncio
async def test_dir_aware_stat_refuses_explicit_dirs():
    stat = dir_aware_stat(_probe_ops(set(), explicit_dirs={"/sub"}), None,
                          None)
    with pytest.raises(IsADirectoryError):
        await stat(PathSpec.from_str_path("/sub"))


@pytest.mark.asyncio
async def test_dir_aware_stat_keeps_enoent_for_missing_files():
    stat = dir_aware_stat(_probe_ops({"/nope.txt"}), None, None)
    with pytest.raises(FileNotFoundError):
        await stat(PathSpec.from_str_path("/nope.txt"))


@pytest.mark.asyncio
async def test_dir_aware_stat_ignores_fabricated_children():
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
    bound = dir_aware_stat(ops, None, None)
    with pytest.raises(FileNotFoundError):
        await bound(PathSpec.from_str_path("/nope.txt"))


@pytest.mark.asyncio
async def test_dir_aware_stat_probe_swallows_driver_errors():
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
    bound = dir_aware_stat(ops, None, None)
    with pytest.raises(FileNotFoundError):
        await bound(PathSpec.from_str_path("/nope.txt"))


@pytest.mark.asyncio
async def test_dir_aware_stream_raises_eisdir_for_dirs():
    read = dir_aware_stream(_probe_ops(set(), implicit_dirs={"/sub"}), None,
                            None)
    with pytest.raises(IsADirectoryError):
        async for _ in read(PathSpec.from_str_path("/sub")):
            raise AssertionError("no data expected")


@pytest.mark.asyncio
async def test_dir_aware_stream_streams_files():
    read = dir_aware_stream(_probe_ops(set()), None, None)
    chunks = [c async for c in read(PathSpec.from_str_path("/f.txt"))]
    assert chunks == [b"data"]
