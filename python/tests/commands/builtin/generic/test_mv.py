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

from mirage.commands.builtin.generic.mv import mv
from mirage.types import (FileStat, FileType, NativeMove, PathSpec,
                          PrimitiveMove)
from mirage.utils.errors import enotsup


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

    async def rename(src, dst) -> None:
        files[_key(dst)] = files.pop(_key(src))

    return stat, rename


async def _run(files, dirs, paths, **kw):
    stat, rename = _make_backend(files, dirs)
    return await mv([_spec(p) for p in paths],
                    strategy=NativeMove(rename=rename),
                    stat=stat,
                    n=kw.get("n", False),
                    v=kw.get("v", False))


@pytest.mark.asyncio
async def test_single_source_renames():
    files = {"/a.txt": b"AAA"}
    await _run(files, set(), ["/a.txt", "/b.txt"])
    assert files["/b.txt"] == b"AAA"
    assert "/a.txt" not in files


@pytest.mark.asyncio
async def test_multiple_sources_into_directory():
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB", "/d/keep": b"K"}
    await _run(files, {"/d"}, ["/a.txt", "/b.txt", "/d"])
    assert files["/d/a.txt"] == b"AAA"
    assert files["/d/b.txt"] == b"BBB"
    assert "/a.txt" not in files
    assert "/b.txt" not in files


@pytest.mark.asyncio
async def test_multiple_sources_nondir_raises():
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB", "/dst.txt": b"DST"}
    with pytest.raises(NotADirectoryError):
        await _run(files, set(), ["/a.txt", "/b.txt", "/dst.txt"])
    assert files["/a.txt"] == b"AAA"
    assert files["/b.txt"] == b"BBB"
    assert files["/dst.txt"] == b"DST"


@pytest.mark.asyncio
async def test_no_clobber_preserves_source_and_target():
    files = {"/a.txt": b"NEW", "/d/a.txt": b"OLD"}
    await _run(files, {"/d"}, ["/a.txt", "/d"], n=True)
    assert files["/d/a.txt"] == b"OLD"
    assert files["/a.txt"] == b"NEW"


@pytest.mark.asyncio
async def test_no_clobber_duplicate_basenames_keeps_skipped_source():
    files = {"/x/a.txt": b"FIRST", "/y/a.txt": b"SECOND", "/d/keep": b"K"}
    await _run(files, {"/d"}, ["/x/a.txt", "/y/a.txt", "/d"], n=True)
    assert files["/d/a.txt"] == b"FIRST"
    assert "/x/a.txt" not in files
    assert files["/y/a.txt"] == b"SECOND"


@pytest.mark.asyncio
async def test_records_writes_for_source_and_target():
    files = {"/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/a.txt", "/d"])
    assert set(io.writes) == {"/a.txt", "/d/a.txt"}


@pytest.mark.asyncio
async def test_missing_source_reports_cannot_stat_and_continues():
    files = {"/b.txt": b"BBB", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/missing.txt", "/b.txt", "/d"])
    assert io.exit_code == 1
    assert b"mv: cannot stat '/missing.txt'" in io.stderr
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
async def test_into_own_subtree_refused():
    files = {"/d/a.txt": b"AAA"}
    _, io = await _run(files, {"/d", "/d/sub"}, ["/d", "/d/sub"])
    assert io.exit_code == 1
    assert b"mv: cannot move '/d' to a subdirectory of itself" in io.stderr
    assert files["/d/a.txt"] == b"AAA"


def _make_primitive(files: dict[str, bytes],
                    dirs: set[str],
                    *,
                    read_fails: dict | None = None,
                    write_fails: dict | None = None,
                    unlink_fails: dict | None = None,
                    rmdir_fails: dict | None = None):
    stat, _ = _make_backend(files, dirs)
    read_err = read_fails or {}
    write_err = write_fails or {}
    unlink_err = unlink_fails or {}
    rmdir_err = rmdir_fails or {}

    async def read_bytes(p) -> bytes:
        if _key(p) in read_err:
            raise read_err[_key(p)]
        return files[_key(p)]

    async def write(p, data: bytes) -> None:
        if _key(p) in write_err:
            raise write_err[_key(p)]
        files[_key(p)] = data

    async def mkdir(p) -> None:
        dirs.add(_key(p))

    async def readdir(p) -> list[str]:
        base = _key(p) + "/"
        children = {
            base + k[len(base):].split("/", 1)[0]
            for k in set(files) | dirs if k.startswith(base)
        }
        return sorted(children)

    async def unlink(p) -> None:
        if _key(p) in unlink_err:
            raise unlink_err[_key(p)]
        del files[_key(p)]

    async def rmdir(p) -> None:
        if _key(p) in rmdir_err:
            raise rmdir_err[_key(p)]
        dirs.discard(_key(p))

    strategy = PrimitiveMove(read_bytes=read_bytes,
                             write=write,
                             mkdir=mkdir,
                             readdir=readdir,
                             unlink=unlink,
                             rmdir=rmdir)
    return stat, strategy


async def _run_primitive(files, dirs, paths, *, v=False, **fail_kw):
    stat, strategy = _make_primitive(files, dirs, **fail_kw)
    return await mv([_spec(p) for p in paths],
                    strategy=strategy,
                    stat=stat,
                    n=False,
                    v=v)


@pytest.mark.asyncio
async def test_primitive_moves_file_across_backends():
    files = {"/src/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run_primitive(files, {"/src", "/d"}, ["/src/a.txt", "/d"])
    assert io.exit_code == 0
    assert files["/d/a.txt"] == b"AAA"
    assert "/src/a.txt" not in files
    assert set(io.writes) == {"/src/a.txt", "/d/a.txt"}


@pytest.mark.asyncio
async def test_primitive_unlink_unsupported_keeps_destination():
    # GNU mv on a cross-device move that cannot remove the source: the
    # copy stays in place and the failure is reported per entry.
    files = {"/src/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run_primitive(
        files, {"/src", "/d"}, ["/src/a.txt", "/d"],
        unlink_fails={"/src/a.txt": enotsup("email", "unlink", "/src/a.txt")})
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot remove '/src/a.txt': "
                         b"Operation not supported\n")
    assert files["/d/a.txt"] == b"AAA"
    assert files["/src/a.txt"] == b"AAA"
    assert set(io.writes) == {"/d/a.txt"}


@pytest.mark.asyncio
async def test_primitive_unlink_failure_continues_remaining_sources():
    files = {"/src/a.txt": b"AAA", "/src/b.txt": b"BBB", "/d/keep": b"K"}
    _, io = await _run_primitive(
        files, {"/src", "/d"}, ["/src/a.txt", "/src/b.txt", "/d"],
        unlink_fails={"/src/a.txt": PermissionError("/src/a.txt")})
    assert io.exit_code == 1
    assert io.stderr == b"mv: cannot remove '/src/a.txt': Permission denied\n"
    assert files["/d/a.txt"] == b"AAA"
    assert files["/d/b.txt"] == b"BBB"
    assert "/src/b.txt" not in files


@pytest.mark.asyncio
async def test_primitive_read_failure_reports_cannot_open():
    files = {"/src/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run_primitive(
        files, {"/src", "/d"}, ["/src/a.txt", "/d"],
        read_fails={"/src/a.txt": PermissionError("/src/a.txt")})
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot open '/src/a.txt' for reading: "
                         b"Permission denied\n")
    assert "/d/a.txt" not in files
    assert files["/src/a.txt"] == b"AAA"
    assert io.writes == {}


@pytest.mark.asyncio
async def test_primitive_write_failure_reports_cannot_create():
    files = {"/src/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run_primitive(
        files, {"/src", "/d"}, ["/src/a.txt", "/d"],
        write_fails={"/d/a.txt": enotsup("notion", "write", "/d/a.txt")})
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot create regular file '/d/a.txt': "
                         b"Operation not supported\n")
    assert files["/src/a.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_primitive_tree_unlink_failure_reports_files_not_dirs():
    # GNU reports each file it cannot remove but never the not-empty
    # ancestor directories; the copied destination tree stays complete.
    files = {"/src/t/a.txt": b"A", "/src/t/sub/b.txt": b"B"}
    dirs = {"/src", "/src/t", "/src/t/sub", "/d"}
    err = {
        "/src/t/a.txt": enotsup("email", "unlink", "/src/t/a.txt"),
        "/src/t/sub/b.txt": enotsup("email", "unlink", "/src/t/sub/b.txt"),
    }
    _, io = await _run_primitive(files,
                                 dirs, ["/src/t", "/d/t"],
                                 unlink_fails=err,
                                 rmdir_fails={
                                     "/src/t":
                                     enotsup("email", "rmdir", "/src/t"),
                                     "/src/t/sub":
                                     enotsup("email", "rmdir", "/src/t/sub"),
                                 })
    assert io.exit_code == 1
    assert io.stderr == (
        b"mv: cannot remove '/src/t/sub/b.txt': Operation not supported\n"
        b"mv: cannot remove '/src/t/a.txt': Operation not supported\n")
    assert files["/d/t/a.txt"] == b"A"
    assert files["/d/t/sub/b.txt"] == b"B"
    assert files["/src/t/a.txt"] == b"A"


@pytest.mark.asyncio
async def test_primitive_tree_copy_failure_skips_removal():
    # GNU keeps the whole source tree when any copy failed, while the
    # destination keeps the entries that landed.
    files = {"/src/t/a.txt": b"A", "/src/t/nr.txt": b"NR"}
    dirs = {"/src", "/src/t", "/d"}
    _, io = await _run_primitive(
        files,
        dirs, ["/src/t", "/d/t"],
        read_fails={"/src/t/nr.txt": PermissionError("/src/t/nr.txt")})
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot open '/src/t/nr.txt' for reading: "
                         b"Permission denied\n")
    assert files["/d/t/a.txt"] == b"A"
    assert files["/src/t/a.txt"] == b"A"
    assert files["/src/t/nr.txt"] == b"NR"


@pytest.mark.asyncio
async def test_primitive_verbose_skips_failed_moves():
    files = {"/src/a.txt": b"AAA", "/src/b.txt": b"BBB", "/d/keep": b"K"}
    out, _ = await _run_primitive(
        files, {"/src", "/d"}, ["/src/a.txt", "/src/b.txt", "/d"],
        v=True,
        unlink_fails={"/src/a.txt": PermissionError("/src/a.txt")})
    assert out == b"renamed '/src/b.txt' -> '/d/b.txt'\n"


@pytest.mark.asyncio
async def test_primitive_rmdir_unsupported_empty_dir_not_an_error():
    # A dirless store cannot remove (or even represent) an empty source
    # directory: once the children moved, a failed rmdir of a dir that no
    # longer lists anything is a completed removal, not an error.
    files = {"/src/t/x.txt": b"X", "/d/keep": b"K"}
    _, io = await _run_primitive(
        files, {"/src", "/src/t", "/d"}, ["/src/t", "/d"],
        rmdir_fails={"/src/t": enotsup("hf", "rmdir", "/src/t")})
    assert io.exit_code == 0
    assert io.stderr is None
    assert files["/d/t/x.txt"] == b"X"
    assert "/src/t/x.txt" not in files
