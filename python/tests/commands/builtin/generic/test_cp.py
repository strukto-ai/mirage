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

from mirage.commands.builtin.generic.cp import cp
from mirage.types import (FileStat, FileType, NativeCopy, PathSpec,
                          PrimitiveCopy)


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


def _key(p) -> str:
    return (p.virtual if isinstance(p, PathSpec) else p).rstrip("/")


def _make_backend(files: dict[str, bytes], dirs: set[str]):

    async def stat(p) -> FileStat:
        k = _key(p)
        if k in dirs:
            return FileStat(name=k.rsplit("/", 1)[-1], type=FileType.DIRECTORY)
        if k in files:
            return FileStat(name=k.rsplit("/", 1)[-1], type=FileType.TEXT)
        raise FileNotFoundError(k)

    async def copy(src, dst) -> None:
        files[_key(dst)] = files[_key(src)]

    async def find(p, type=None) -> list[str]:
        base = _key(p) + "/"
        return sorted(k for k in files if k.startswith(base))

    return stat, copy, find


async def _run(files, dirs, paths, **kw):
    stat, copy, find = _make_backend(files, dirs)
    return await cp([_spec(p) for p in paths],
                    strategy=NativeCopy(copy=copy, find=find),
                    find_type="f",
                    stat=stat,
                    recursive=kw.get("recursive", False),
                    n=kw.get("n", False),
                    v=kw.get("v", False))


@pytest.mark.asyncio
async def test_single_source_to_new_path():
    files = {"/a.txt": b"AAA"}
    await _run(files, set(), ["/a.txt", "/copy.txt"])
    assert files["/copy.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_single_source_into_directory():
    files = {"/a.txt": b"AAA", "/d/keep": b"K"}
    await _run(files, {"/d"}, ["/a.txt", "/d"])
    assert files["/d/a.txt"] == b"AAA"
    assert files["/a.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_multiple_sources_into_directory():
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB", "/d/keep": b"K"}
    await _run(files, {"/d"}, ["/a.txt", "/b.txt", "/d"])
    assert files["/d/a.txt"] == b"AAA"
    assert files["/d/b.txt"] == b"BBB"


@pytest.mark.asyncio
async def test_multiple_sources_nondir_raises():
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB", "/dst.txt": b"DST"}
    with pytest.raises(NotADirectoryError):
        await _run(files, set(), ["/a.txt", "/b.txt", "/dst.txt"])
    assert files["/dst.txt"] == b"DST"


@pytest.mark.asyncio
async def test_no_clobber_skips_existing():
    files = {"/a.txt": b"NEW", "/d/a.txt": b"OLD"}
    await _run(files, {"/d"}, ["/a.txt", "/d"], n=True)
    assert files["/d/a.txt"] == b"OLD"


@pytest.mark.asyncio
async def test_no_clobber_duplicate_basenames_first_wins():
    files = {"/x/a.txt": b"FIRST", "/y/a.txt": b"SECOND", "/d/keep": b"K"}
    await _run(files, {"/d"}, ["/x/a.txt", "/y/a.txt", "/d"], n=True)
    assert files["/d/a.txt"] == b"FIRST"


@pytest.mark.asyncio
async def test_duplicate_basenames_without_n_last_wins():
    files = {"/x/a.txt": b"FIRST", "/y/a.txt": b"SECOND", "/d/keep": b"K"}
    await _run(files, {"/d"}, ["/x/a.txt", "/y/a.txt", "/d"])
    assert files["/d/a.txt"] == b"SECOND"


@pytest.mark.asyncio
async def test_recursive_into_directory():
    files = {"/src/x.txt": b"X", "/src/sub/y.txt": b"Y"}
    await _run(files, {"/src"}, ["/src", "/dst"], recursive=True)
    assert files["/dst/x.txt"] == b"X"
    assert files["/dst/sub/y.txt"] == b"Y"


@pytest.mark.asyncio
async def test_verbose_emits_arrow_lines():
    files = {"/a.txt": b"AAA"}
    out, _ = await _run(files, set(), ["/a.txt", "/copy.txt"], v=True)
    assert out == b"'/a.txt' -> '/copy.txt'\n"


@pytest.mark.asyncio
async def test_records_writes_by_strip_prefix():
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/a.txt", "/b.txt", "/d"])
    assert set(io.writes) == {"/d/a.txt", "/d/b.txt"}


@pytest.mark.asyncio
async def test_missing_source_reports_cannot_stat_and_continues():
    files = {"/b.txt": b"BBB", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/missing.txt", "/b.txt", "/d"])
    assert io.exit_code == 1
    assert b"cp: cannot stat '/missing.txt'" in io.stderr
    assert files["/d/b.txt"] == b"BBB"


@pytest.mark.asyncio
async def test_same_file_errors_and_preserves_content():
    files = {"/a.txt": b"AAA"}
    _, io = await _run(files, set(), ["/a.txt", "/a.txt"])
    assert io.exit_code == 1
    assert b"'/a.txt' and '/a.txt' are the same file" in io.stderr
    assert files["/a.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_same_file_via_directory_target_errors():
    files = {"/d/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/d/a.txt", "/d"])
    assert io.exit_code == 1
    assert b"are the same file" in io.stderr
    assert files["/d/a.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_recursive_into_own_subtree_refused():
    files = {"/d/a.txt": b"AAA"}
    _, io = await _run(files, {"/d"}, ["/d", "/d"], recursive=True)
    assert io.exit_code == 1
    assert b"cp: cannot copy a directory, '/d', into itself" in io.stderr
    assert set(files) == {"/d/a.txt"}


@pytest.mark.asyncio
async def test_recursive_into_nested_subtree_refused():
    files = {"/d/a.txt": b"AAA"}
    _, io = await _run(files, {"/d", "/d/sub"}, ["/d", "/d/sub"],
                       recursive=True)
    assert io.exit_code == 1
    assert b"into itself" in io.stderr
    assert set(files) == {"/d/a.txt"}


@pytest.mark.asyncio
async def test_primitive_copy_records_source_reads():
    files = {"/a.txt": b"AAA"}
    stat, _, _ = _make_backend(files, set())

    async def read_bytes(p) -> bytes:
        return files[_key(p)]

    async def write(p, data: bytes) -> None:
        files[_key(p)] = data

    _, io = await cp([_spec("/a.txt"), _spec("/copy.txt")],
                     stat=stat,
                     strategy=PrimitiveCopy(read_bytes=read_bytes,
                                            write=write,
                                            mkdir=write,
                                            readdir=write),
                     recursive=False,
                     n=False,
                     v=False)
    assert files["/copy.txt"] == b"AAA"
    assert io.reads == {"/a.txt": b"AAA"}
    assert io.cache == ["/a.txt"]


@pytest.mark.asyncio
async def test_native_copy_records_no_reads():
    files = {"/a.txt": b"AAA"}
    _, io = await _run(files, set(), ["/a.txt", "/copy.txt"])
    assert io.reads == {}
    assert io.cache == []
