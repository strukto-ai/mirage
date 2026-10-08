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

from mirage.commands.builtin.generic.mv import MvFlags, mv_generic
from mirage.errors.fs import enoent, enotdir, enotsup
from mirage.types import (
    ContentType,
    FileStat,
    FileType,
    NativeMove,
    PathSpec,
    PrimitiveMove,
)


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path, directory=path, vfs_path=path.strip("/"))


def _key(p) -> str:
    return (p.virtual if isinstance(p, PathSpec) else p).rstrip("/")


def _slashed(path: str) -> PathSpec:
    return PathSpec(
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
        vfs_path=path.strip("/"),
        raw_path=path + "/",
    )


def _make_backend(files: dict[str, bytes], dirs: set[str]):
    async def stat(p) -> FileStat:
        k = _key(p)
        if k in dirs:
            return FileStat(name=k.rsplit("/", 1)[-1], type=FileType.DIRECTORY)
        if k in files:
            return FileStat(
                name=k.rsplit("/", 1)[-1],
                type=FileType.FILE,
                content=ContentType.TEXT,
            )
        raise FileNotFoundError(k)

    async def rename(src, dst) -> None:
        files[_key(dst)] = files.pop(_key(src))

    return stat, rename


async def _run(files, dirs, paths, *, readdir=None, **kw):
    stat, rename = _make_backend(files, dirs)
    flags = kw.pop("flags", None) or MvFlags(
        no_clobber=kw.get("no_clobber", False),
        verbose=kw.get("verbose", False),
    )
    return await mv_generic(
        [_spec(p) for p in paths],
        strategy=NativeMove(rename=rename),
        stat=stat,
        flags=flags,
        readdir=readdir,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target, error, match",
    [
        (_spec("/dst.txt"), NotADirectoryError, "target '/dst.txt'"),
        (_slashed("/missing"), FileNotFoundError, "target '/missing/'"),
    ],
)
async def test_many_sources_need_a_directory_target(target, error, match):
    files = {
        "/a.txt": b"AAA",
        "/b.txt": b"BBB",
        "/dst.txt": b"D",
        "/reg": b"R",
    }
    before = dict(files)
    stat, rename = _make_backend(files, set())
    with pytest.raises(error, match=match):
        await mv_generic(
            [_spec("/a.txt"), _spec("/b.txt"), target],
            strategy=NativeMove(rename=rename),
            stat=stat,
            flags=MvFlags(),
        )
    assert files == before


@pytest.mark.asyncio
async def test_rename_onto_nondir_parent_reports_not_a_directory():
    files = {"/a.txt": b"AAA"}
    stat, _ = _make_backend(files, set())

    async def rename(src, dst) -> None:
        raise enotdir(dst)

    _, io = await mv_generic(
        [_spec(p) for p in ["/a.txt", "/plain/c.txt"]],
        strategy=NativeMove(rename=rename),
        stat=stat,
        flags=MvFlags(),
    )
    assert io.exit_code == 1
    assert io.stderr == (
        b"mv: cannot move '/a.txt' to '/plain/c.txt': Not a directory\n"
    )


@pytest.mark.asyncio
async def test_a_failed_operand_is_named_as_typed():
    # GNU (coreutils 9.7) keeps the trailing slash when the operand itself
    # failed: mv: cannot move 'd/' to 'nonexist/sub/'.
    files = {"/d/a.txt": b"A"}
    stat, _ = _make_backend(files, {"/d"})

    async def rename(src, dst) -> None:
        raise enoent(dst)

    _, io = await mv_generic(
        [_spec(p) for p in ["/d/", "/gone/x/"]],
        strategy=NativeMove(rename=rename),
        stat=stat,
        flags=MvFlags(),
    )
    assert io.stderr == (
        b"mv: cannot move '/d/' to '/gone/x/': No such file or directory\n"
    )


@pytest.mark.asyncio
async def test_rename_failure_keeps_moving_remaining_sources():
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB"}
    stat, real_rename = _make_backend(files, {"/d"})

    async def rename(src, dst) -> None:
        if src.virtual == "/a.txt":
            raise enoent(dst)
        await real_rename(src, dst)

    _, io = await mv_generic(
        [_spec(p) for p in ["/a.txt", "/b.txt", "/d"]],
        strategy=NativeMove(rename=rename),
        stat=stat,
        flags=MvFlags(),
    )
    assert io.exit_code == 1
    assert b"mv: cannot move '/a.txt' to '/d/a.txt'" in io.stderr
    assert files["/d/b.txt"] == b"BBB"
    assert files["/a.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_no_clobber_duplicate_basenames_keeps_skipped_source():
    files = {"/x/a.txt": b"FIRST", "/y/a.txt": b"SECOND", "/d/keep": b"K"}
    await _run(files, {"/d"}, ["/x/a.txt", "/y/a.txt", "/d"], no_clobber=True)
    assert files["/d/a.txt"] == b"FIRST"
    assert "/x/a.txt" not in files
    assert files["/y/a.txt"] == b"SECOND"


def _make_primitive(
    files: dict[str, bytes],
    dirs: set[str],
    *,
    read_fails: dict | None = None,
    write_fails: dict | None = None,
    unlink_fails: dict | None = None,
    rmdir_fails: dict | None = None,
):
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
            base + k[len(base) :].split("/", 1)[0]
            for k in set(files) | dirs
            if k.startswith(base)
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

    strategy = PrimitiveMove(
        read_bytes=read_bytes,
        write=write,
        mkdir=mkdir,
        readdir=readdir,
        unlink=unlink,
        rmdir=rmdir,
    )
    return stat, strategy


async def _run_primitive(
    files, dirs, paths, *, verbose=False, flags=None, **fail_kw
):
    stat, strategy = _make_primitive(files, dirs, **fail_kw)
    return await mv_generic(
        [_spec(p) for p in paths],
        strategy=strategy,
        stat=stat,
        flags=flags or MvFlags(verbose=verbose),
    )


_PERM = PermissionError("denied")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "run, files, dirs, paths, kw, exit_code, writes",
    [
        (
            _run,
            {"/a.txt": b"AAA", "/d/keep": b"K"},
            {"/d"},
            ["/a.txt", "/d"],
            {},
            0,
            {"/a.txt", "/d/a.txt"},
        ),
        (
            _run_primitive,
            {"/src/a.txt": b"AAA", "/d/keep": b"K"},
            {"/src", "/d"},
            ["/src/a.txt", "/d"],
            {},
            0,
            {"/src/a.txt", "/d/a.txt"},
        ),
        (
            _run_primitive,
            {"/src/a.txt": b"AAA", "/d/keep": b"K"},
            {"/src", "/d"},
            ["/src/a.txt", "/d"],
            {
                "unlink_fails": {
                    "/src/a.txt": enotsup("email", "unlink", "a.txt")
                }
            },
            1,
            {"/d/a.txt"},
        ),
        (
            _run_primitive,
            {"/src/a.txt": b"AAA", "/d/keep": b"K"},
            {"/src", "/d"},
            ["/src/a.txt", "/d"],
            {"read_fails": {"/src/a.txt": _PERM}},
            1,
            set(),
        ),
        (
            _run,
            {"/a.txt": b"SRC", "/b.txt": b"DST"},
            set(),
            ["/a.txt", "/b.txt"],
            {"flags": MvFlags(backup="simple")},
            0,
            {"/a.txt", "/b.txt", "/b.txt~"},
        ),
        (
            _run,
            {"/a.txt": b"AAA", "/b.txt": b"BBB"},
            set(),
            ["/a.txt", "/b.txt"],
            {"flags": MvFlags(exchange=True)},
            0,
            {"/a.txt", "/b.txt"},
        ),
    ],
)
async def test_records_writes(run, files, dirs, paths, kw, exit_code, writes):
    _, io = await run(files, dirs, paths, **kw)
    assert io.exit_code == exit_code
    assert set(io.writes) == writes


_TWO = {"/src/a.txt": b"AAA", "/src/b.txt": b"BBB", "/d/keep": b"K"}
_TWO_MOVED = {
    "/src/a.txt": b"AAA",
    "/d/keep": b"K",
    "/d/a.txt": b"AAA",
    "/d/b.txt": b"BBB",
}
_DENIED_A = b"mv: cannot remove '/src/a.txt': Permission denied\n"


def _unsup(op: str, *paths: str) -> dict[str, OSError]:
    return {p: enotsup("email", op, p) for p in paths}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "files, dirs, paths, kw, exit_code, out, err, after",
    [
        (
            _TWO,
            {"/src", "/d"},
            ["/src/a.txt", "/src/b.txt", "/d"],
            {"unlink_fails": {"/src/a.txt": _PERM}},
            1,
            None,
            _DENIED_A,
            _TWO_MOVED,
        ),
        (
            _TWO,
            {"/src", "/d"},
            ["/src/a.txt", "/src/b.txt", "/d"],
            {"verbose": True, "unlink_fails": {"/src/a.txt": _PERM}},
            1,
            b"renamed '/src/b.txt' -> '/d/b.txt'\n",
            _DENIED_A,
            _TWO_MOVED,
        ),
        (
            {"/src/a.txt": b"AAA", "/d/keep": b"K"},
            {"/src", "/d"},
            ["/src/a.txt", "/d"],
            {"read_fails": {"/src/a.txt": _PERM}},
            1,
            None,
            b"mv: cannot open '/src/a.txt' for reading: Permission denied\n",
            {"/src/a.txt": b"AAA", "/d/keep": b"K"},
        ),
        (
            {"/src/t/a.txt": b"A", "/src/t/sub/b.txt": b"B"},
            {"/src", "/src/t", "/src/t/sub", "/d"},
            ["/src/t", "/d/t"],
            {
                "unlink_fails": _unsup(
                    "unlink", "/src/t/a.txt", "/src/t/sub/b.txt"
                ),
                "rmdir_fails": _unsup("rmdir", "/src/t", "/src/t/sub"),
            },
            1,
            None,
            b"mv: cannot remove '/src/t/sub/b.txt': Operation not supported\n"
            b"mv: cannot remove '/src/t/a.txt': Operation not supported\n",
            {
                "/src/t/a.txt": b"A",
                "/src/t/sub/b.txt": b"B",
                "/d/t/a.txt": b"A",
                "/d/t/sub/b.txt": b"B",
            },
        ),
        (
            {"/src/t/a.txt": b"A", "/src/t/nr.txt": b"NR"},
            {"/src", "/src/t", "/d"},
            ["/src/t", "/d/t"],
            {"read_fails": {"/src/t/nr.txt": _PERM}},
            1,
            None,
            b"mv: cannot open '/src/t/nr.txt' for reading: Permission denied\n",
            {"/src/t/a.txt": b"A", "/src/t/nr.txt": b"NR", "/d/t/a.txt": b"A"},
        ),
        (
            {"/src/t/x.txt": b"X", "/d/keep": b"K"},
            {"/src", "/src/t", "/d"},
            ["/src/t", "/d"],
            {"rmdir_fails": _unsup("rmdir", "/src/t")},
            0,
            None,
            None,
            {"/d/keep": b"K", "/d/t/x.txt": b"X"},
        ),
    ],
    ids=[
        "unlink-failure-continues",
        "verbose-skips-failed",
        "read-failure",
        "tree-unlink-reports-files-not-dirs",
        "tree-copy-failure-keeps-source",
        "rmdir-unsupported-on-emptied-dir",
    ],
)
async def test_primitive_faults(
    files, dirs, paths, kw, exit_code, out, err, after
):
    files = dict(files)
    stdout, io = await _run_primitive(files, set(dirs), paths, **kw)
    assert io.exit_code == exit_code
    assert stdout == out
    assert io.stderr == err
    assert files == after


def _dir_readdir(files, dirs):
    async def readdir(p) -> list[str]:
        base = _key(p) + "/" if _key(p) != "/" else "/"
        children = {
            base + k[len(base) :].split("/", 1)[0]
            for k in set(files) | dirs
            if k.startswith(base) and k != _key(p)
        }
        return sorted(children)

    return readdir


@pytest.mark.asyncio
async def test_no_target_dir_refuses_dir_dest_for_file():
    files = {"/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run(
        files, {"/d"}, ["/a.txt", "/d"], flags=MvFlags(no_target_dir=True)
    )
    assert io.exit_code == 1
    assert io.stderr == (
        b"mv: cannot overwrite directory '/d' with non-directory '/a.txt'\n"
    )


@pytest.mark.asyncio
async def test_target_dir_missing_fails_whole_command():
    files = {"/a.txt": b"AAA"}
    _, io = await _run(
        files,
        set(),
        ["/a.txt"],
        flags=MvFlags(target_dir=PathSpec.from_str_path("/nosuch")),
    )
    assert io.exit_code == 1
    assert io.stderr == (
        b"mv: target directory '/nosuch': No such file or directory\n"
    )
    assert files["/a.txt"] == b"AAA"


def test_parse_mv_flags_conflicts_and_grammar():
    from mirage.commands.builtin.generic.mv import parse_flags
    from mirage.commands.errors import UsageError
    from mirage.commands.spec import SPECS
    from mirage.commands.spec.flag_view import FlagView

    def view(bag):
        return FlagView(bag, spec=SPECS["mv"])

    with pytest.raises(UsageError) as exc:
        parse_flags(view({"backup": True, "no_clobber": True}))
    assert (
        "mv: cannot combine --backup with --exchange, -n, or "
        "--update=none-fail" in str(exc.value)
    )
    parsed = parse_flags(view({"update": True, "exchange": True}))
    assert parsed.update == "older"
    assert parsed.exchange is True


@pytest.mark.asyncio
async def test_no_target_dir_backup_none_still_refuses_nonempty():
    # --backup=none displaces nothing, so the refusal must still apply.
    files = {"/d1/x.txt": b"X", "/d2/y.txt": b"Y"}
    dirs = {"/d1", "/d2"}
    _, io = await _run(
        files,
        dirs,
        ["/d1", "/d2"],
        readdir=_dir_readdir(files, dirs),
        flags=MvFlags(no_target_dir=True, backup="none"),
    )
    assert io.exit_code == 1
    assert io.stderr == b"mv: cannot overwrite '/d2': Directory not empty\n"


@pytest.mark.asyncio
async def test_no_target_dir_reports_failed_emptiness_probe():
    # Reading a failed listing as "empty" would clobber a directory whose
    # contents could not be verified.
    files = {"/d1/x.txt": b"X", "/d2/y.txt": b"Y"}
    dirs = {"/d1", "/d2"}

    async def failing_readdir(p) -> list[str]:
        raise enotsup("ram", "readdir", p)

    _, io = await _run(
        files,
        dirs,
        ["/d1", "/d2"],
        readdir=failing_readdir,
        flags=MvFlags(no_target_dir=True),
    )
    assert io.exit_code == 1
    assert io.stderr == (
        b"mv: cannot overwrite '/d2': Operation not supported\n"
    )
    assert files["/d2/y.txt"] == b"Y"


@pytest.mark.asyncio
async def test_primitive_directory_target_backup_transfers_the_tree():
    # A cross-mount mv -b -T has a directory target: read_bytes cannot copy
    # it, so the backup walks the tree entry by entry.
    files = {"/src/x.txt": b"X", "/d/y.txt": b"Y", "/d/sub/z.txt": b"Z"}
    dirs = {"/src", "/d", "/d/sub"}
    _, io = await _run_primitive(
        files,
        dirs,
        ["/src", "/d"],
        flags=MvFlags(no_target_dir=True, backup="simple"),
    )
    assert io.exit_code == 0
    assert io.stderr is None
    assert files["/d~/y.txt"] == b"Y"
    assert files["/d~/sub/z.txt"] == b"Z"
    assert files["/d/x.txt"] == b"X"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failing_calls, err, after",
    [
        (
            {2},
            b"mv: cannot exchange '/a.txt' and '/b.txt': Permission denied\n",
            {"/a.txt": b"A", "/b.txt": b"B"},
        ),
        (
            range(2, 10),
            b"mv: cannot exchange '/a.txt' and '/b.txt': Permission denied\n"
            b"mv: '/a.txt' left at '/b.txt.~xchg~' after a failed exchange\n",
            {"/b.txt": b"B", "/b.txt.~xchg~": b"A"},
        ),
    ],
)
async def test_exchange_failure_rolls_back_or_reports_leftover(
    failing_calls, err, after
):
    files = {"/a.txt": b"A", "/b.txt": b"B"}
    stat, rename = _make_backend(files, set())
    calls = {"n": 0}

    async def flaky_rename(src, dst) -> None:
        calls["n"] += 1
        if calls["n"] in failing_calls:
            raise PermissionError("boom")
        await rename(src, dst)

    _, io = await mv_generic(
        [_spec(p) for p in ["/a.txt", "/b.txt"]],
        strategy=NativeMove(rename=flaky_rename),
        stat=stat,
        flags=MvFlags(exchange=True),
    )
    assert io.exit_code == 1
    assert io.stderr == err
    assert files == after
