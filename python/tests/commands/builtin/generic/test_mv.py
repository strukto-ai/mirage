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

from mirage.commands.builtin.generic.mv import MvFlags, mv
from mirage.types import (FileStat, FileType, NativeMove, PathSpec,
                          PrimitiveMove)
from mirage.utils.errors import enoent, enotdir, enotsup


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


def _key(p) -> str:
    return (p.virtual if isinstance(p, PathSpec) else p).rstrip("/")


def _make_backend(files: dict[str, bytes],
                  dirs: set[str],
                  mtimes: dict[str, str] | None = None):
    stamps = mtimes or {}

    async def stat(p) -> FileStat:
        k = _key(p)
        if k in dirs:
            return FileStat(name=k.rsplit("/", 1)[-1], type=FileType.DIRECTORY)
        if k in files:
            return FileStat(name=k.rsplit("/", 1)[-1],
                            type=FileType.TEXT,
                            modified=stamps.get(k))
        raise FileNotFoundError(k)

    async def rename(src, dst) -> None:
        files[_key(dst)] = files.pop(_key(src))

    return stat, rename


async def _run(files, dirs, paths, *, readdir=None, mtimes=None, **kw):
    stat, rename = _make_backend(files, dirs, mtimes)
    flags = kw.pop("flags", None) or MvFlags(no_clobber=kw.get(
        "no_clobber", False),
                                             verbose=kw.get("verbose", False))
    return await mv([_spec(p) for p in paths],
                    strategy=NativeMove(rename=rename),
                    stat=stat,
                    flags=flags,
                    readdir=readdir)


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
async def test_refusing_backend_rename_reports_cannot_move():
    files = {"/a.txt": b"AAA"}
    stat, _ = _make_backend(files, set())

    async def rename(src, dst) -> None:
        raise enoent(dst)

    _, io = await mv([_spec(p) for p in ["/a.txt", "/missing/a.txt"]],
                     strategy=NativeMove(rename=rename),
                     stat=stat,
                     flags=MvFlags())
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot move '/a.txt' to '/missing/a.txt': "
                         b"No such file or directory\n")
    assert files["/a.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_rename_onto_nondir_parent_reports_not_a_directory():
    files = {"/a.txt": b"AAA"}
    stat, _ = _make_backend(files, set())

    async def rename(src, dst) -> None:
        raise enotdir(dst)

    _, io = await mv([_spec(p) for p in ["/a.txt", "/plain/c.txt"]],
                     strategy=NativeMove(rename=rename),
                     stat=stat,
                     flags=MvFlags())
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot move '/a.txt' to '/plain/c.txt': "
                         b"Not a directory\n")


@pytest.mark.asyncio
async def test_rename_failure_keeps_moving_remaining_sources():
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB"}
    stat, real_rename = _make_backend(files, {"/d"})

    async def rename(src, dst) -> None:
        if src.virtual == "/a.txt":
            raise enoent(dst)
        await real_rename(src, dst)

    _, io = await mv([_spec(p) for p in ["/a.txt", "/b.txt", "/d"]],
                     strategy=NativeMove(rename=rename),
                     stat=stat,
                     flags=MvFlags())
    assert io.exit_code == 1
    assert b"mv: cannot move '/a.txt' to '/d/a.txt'" in io.stderr
    assert files["/d/b.txt"] == b"BBB"
    assert files["/a.txt"] == b"AAA"


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
    await _run(files, {"/d"}, ["/a.txt", "/d"], no_clobber=True)
    assert files["/d/a.txt"] == b"OLD"
    assert files["/a.txt"] == b"NEW"


@pytest.mark.asyncio
async def test_no_clobber_duplicate_basenames_keeps_skipped_source():
    files = {"/x/a.txt": b"FIRST", "/y/a.txt": b"SECOND", "/d/keep": b"K"}
    await _run(files, {"/d"}, ["/x/a.txt", "/y/a.txt", "/d"], no_clobber=True)
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


async def _run_primitive(files,
                         dirs,
                         paths,
                         *,
                         verbose=False,
                         flags=None,
                         **fail_kw):
    stat, strategy = _make_primitive(files, dirs, **fail_kw)
    return await mv([_spec(p) for p in paths],
                    strategy=strategy,
                    stat=stat,
                    flags=flags or MvFlags(verbose=verbose))


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
        verbose=True,
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


_OLD = "2020-01-01T00:00:00+00:00"
_NEW = "2024-01-01T00:00:00+00:00"


def _dir_readdir(files, dirs):

    async def readdir(p) -> list[str]:
        base = _key(p) + "/" if _key(p) != "/" else "/"
        children = {
            base + k[len(base):].split("/", 1)[0]
            for k in set(files) | dirs if k.startswith(base) and k != _key(p)
        }
        return sorted(children)

    return readdir


@pytest.mark.asyncio
async def test_update_older_skips_newer_dest_and_keeps_source():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       mtimes={
                           "/a.txt": _OLD,
                           "/b.txt": _NEW
                       },
                       flags=MvFlags(update="older"))
    assert io.exit_code == 0
    assert files["/a.txt"] == b"SRC"
    assert files["/b.txt"] == b"DST"


@pytest.mark.asyncio
async def test_update_older_replaces_older_dest():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    await _run(files,
               set(), ["/a.txt", "/b.txt"],
               mtimes={
                   "/a.txt": _NEW,
                   "/b.txt": _OLD
               },
               flags=MvFlags(update="older"))
    assert files["/b.txt"] == b"SRC"
    assert "/a.txt" not in files


@pytest.mark.asyncio
async def test_update_none_fail_reports_not_replacing():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       flags=MvFlags(update="none-fail"))
    assert io.exit_code == 1
    assert io.stderr == b"mv: not replacing '/b.txt'\n"
    assert files["/a.txt"] == b"SRC"


@pytest.mark.asyncio
async def test_backup_renames_dest_away():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       flags=MvFlags(backup="simple"))
    assert files["/b.txt"] == b"SRC"
    assert files["/b.txt~"] == b"DST"
    assert "/a.txt" not in files
    assert "/b.txt~" in io.writes


@pytest.mark.asyncio
async def test_verbose_backup_annotation():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    out, _ = await _run(files,
                        set(), ["/a.txt", "/b.txt"],
                        flags=MvFlags(verbose=True, backup="simple"))
    assert out == b"renamed '/a.txt' -> '/b.txt' (backup: '/b.txt~')\n"


@pytest.mark.asyncio
async def test_exchange_swaps_contents():
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       flags=MvFlags(exchange=True))
    assert io.exit_code == 0
    assert files["/a.txt"] == b"BBB"
    assert files["/b.txt"] == b"AAA"
    assert set(io.writes) == {"/a.txt", "/b.txt"}


@pytest.mark.asyncio
async def test_exchange_verbose_line():
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB"}
    out, _ = await _run(files,
                        set(), ["/a.txt", "/b.txt"],
                        flags=MvFlags(exchange=True, verbose=True))
    assert out == b"exchanged '/a.txt' <-> '/b.txt'\n"


@pytest.mark.asyncio
async def test_exchange_missing_target_errors():
    # Deliberate divergence: GNU's renameat2 probe reports the unhelpful
    # 'Unknown error -1' here; the honest errno text is used instead.
    files = {"/a.txt": b"AAA"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       flags=MvFlags(exchange=True))
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot exchange '/a.txt' and '/b.txt': "
                         b"No such file or directory\n")
    assert files["/a.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_exchange_cross_mount_refused():
    files = {"/src/a.txt": b"AAA", "/d/b.txt": b"BBB"}
    _, io = await _run_primitive(files, {"/src", "/d"},
                                 ["/src/a.txt", "/d/b.txt"],
                                 flags=MvFlags(exchange=True))
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot exchange '/src/a.txt' and "
                         b"'/d/b.txt': Invalid cross-device link\n")
    assert files["/src/a.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_no_copy_refuses_cross_mount_move():
    files = {"/src/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run_primitive(files, {"/src", "/d"}, ["/src/a.txt", "/d"],
                                 flags=MvFlags(no_copy=True))
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot move '/src/a.txt' to '/d/a.txt': "
                         b"Invalid cross-device link\n")
    assert files["/src/a.txt"] == b"AAA"
    assert "/d/a.txt" not in files


@pytest.mark.asyncio
async def test_no_copy_native_rename_unaffected():
    files = {"/a.txt": b"AAA"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       flags=MvFlags(no_copy=True))
    assert io.exit_code == 0
    assert files["/b.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_no_target_dir_refuses_nonempty_dir_dest():
    files = {"/d1/x.txt": b"X", "/d2/y.txt": b"Y"}
    dirs = {"/d1", "/d2"}
    _, io = await _run(files,
                       dirs, ["/d1", "/d2"],
                       readdir=_dir_readdir(files, dirs),
                       flags=MvFlags(no_target_dir=True))
    assert io.exit_code == 1
    assert io.stderr == b"mv: cannot overwrite '/d2': Directory not empty\n"


@pytest.mark.asyncio
async def test_overwrite_nondir_with_dir_refused():
    files = {"/f.txt": b"F", "/d/x.txt": b"X"}
    _, io = await _run(files, {"/d"}, ["/d", "/f.txt"])
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot overwrite non-directory '/f.txt' "
                         b"with directory '/d'\n")


@pytest.mark.asyncio
async def test_no_target_dir_refuses_dir_dest_for_file():
    files = {"/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/a.txt", "/d"],
                       flags=MvFlags(no_target_dir=True))
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot overwrite directory '/d' with "
                         b"non-directory '/a.txt'\n")


@pytest.mark.asyncio
async def test_target_dir_moves_into():
    files = {"/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/a.txt"],
                       flags=MvFlags(target_dir="/d"))
    assert io.exit_code == 0
    assert files["/d/a.txt"] == b"AAA"
    assert "/a.txt" not in files


@pytest.mark.asyncio
async def test_target_dir_missing_fails_whole_command():
    files = {"/a.txt": b"AAA"}
    _, io = await _run(files,
                       set(), ["/a.txt"],
                       flags=MvFlags(target_dir="/nosuch"))
    assert io.exit_code == 1
    assert io.stderr == (b"mv: target directory '/nosuch': "
                         b"No such file or directory\n")
    assert files["/a.txt"] == b"AAA"


def test_parse_mv_flags_conflicts_and_grammar():
    from mirage.commands.builtin.generic.mv import parse_mv_flags
    from mirage.commands.errors import UsageError
    from mirage.commands.spec import SPECS
    from mirage.commands.spec.types import FlagView

    def view(bag):
        return FlagView(bag, spec=SPECS["mv"])

    with pytest.raises(UsageError) as exc:
        parse_mv_flags(view({"backup": True, "exchange": True}))
    assert "mv: cannot combine --backup with --exchange, -n, or " \
           "--update=none-fail" in str(exc.value)
    with pytest.raises(UsageError) as exc:
        parse_mv_flags(view({"backup": True, "no_clobber": True}))
    assert "cannot combine --backup" in str(exc.value)
    with pytest.raises(UsageError) as exc:
        parse_mv_flags(
            view({
                "target_directory": "/d",
                "no_target_directory": True
            }))
    assert "cannot combine --target-directory" in str(exc.value)
    parsed = parse_mv_flags(view({"update": True, "exchange": True}))
    assert parsed.update == "older"
    assert parsed.exchange is True
    assert parse_mv_flags(view({"no_copy": True})).no_copy is True
    # GNU 9.7: `mv --backup --suffix= f g` writes g~, so an empty suffix
    # reads as absent rather than naming the original as its own backup.
    assert parse_mv_flags(view({"backup": True, "suffix": ""})).suffix == "~"


def _tree_rename(files: dict[str, bytes], dirs: set[str]):
    """A rename that carries a whole subtree, like a real backend rename."""

    async def rename(src, dst) -> None:
        s, d = _key(src), _key(dst)
        if s in dirs:
            dirs.discard(s)
            dirs.add(d)
            for k in [k for k in files if k.startswith(s + "/")]:
                files[d + k[len(s):]] = files.pop(k)
            for k in [k for k in dirs if k.startswith(s + "/")]:
                dirs.discard(k)
                dirs.add(d + k[len(s):])
            return
        files[d] = files.pop(s)

    return rename


@pytest.mark.asyncio
async def test_exchange_never_clobbers_an_existing_holding_name():
    # GNU's renameat2(RENAME_EXCHANGE) is atomic and touches nothing else,
    # so a real file already sitting at the staging name must survive.
    files = {"/a.txt": b"A", "/b.txt": b"B", "/b.txt.~xchg~": b"PRECIOUS"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       flags=MvFlags(exchange=True))
    assert io.exit_code == 0
    assert files["/a.txt"] == b"B"
    assert files["/b.txt"] == b"A"
    assert files["/b.txt.~xchg~"] == b"PRECIOUS"


@pytest.mark.asyncio
async def test_exchange_rolls_back_when_second_rename_fails():
    files = {"/a.txt": b"A", "/b.txt": b"B"}
    stat, rename = _make_backend(files, set())
    calls = {"n": 0}

    async def flaky_rename(src, dst) -> None:
        calls["n"] += 1
        if calls["n"] == 2:
            raise PermissionError("boom")
        await rename(src, dst)

    _, io = await mv([_spec(p) for p in ["/a.txt", "/b.txt"]],
                     strategy=NativeMove(rename=flaky_rename),
                     stat=stat,
                     flags=MvFlags(exchange=True))
    assert io.exit_code == 1
    # Both operands are back where they started, and no staging file leaks.
    assert files == {"/a.txt": b"A", "/b.txt": b"B"}
    assert b"cannot exchange" in bytes(io.stderr or b"")
    assert b"left at" not in bytes(io.stderr or b"")


@pytest.mark.asyncio
async def test_exchange_reports_leftover_when_rollback_also_fails():
    files = {"/a.txt": b"A", "/b.txt": b"B"}
    stat, rename = _make_backend(files, set())
    calls = {"n": 0}

    async def flaky_rename(src, dst) -> None:
        calls["n"] += 1
        if calls["n"] >= 2:
            raise PermissionError("boom")
        await rename(src, dst)

    _, io = await mv([_spec(p) for p in ["/a.txt", "/b.txt"]],
                     strategy=NativeMove(rename=flaky_rename),
                     stat=stat,
                     flags=MvFlags(exchange=True))
    assert io.exit_code == 1
    stderr = bytes(io.stderr or b"")
    assert b"cannot exchange" in stderr
    # The source is parked at the staging name; say so instead of losing it.
    assert b"'/a.txt' left at '/b.txt.~xchg~'" in stderr


@pytest.mark.asyncio
async def test_no_target_dir_backup_displaces_nonempty_dir_dest():
    # GNU 9.7: mv -b -T renames the nonempty target aside, then installs the
    # source, instead of refusing with "Directory not empty".
    files = {"/d1/x.txt": b"X", "/d2/y.txt": b"Y"}
    dirs = {"/d1", "/d2"}
    stat, _ = _make_backend(files, dirs)
    _, io = await mv([_spec(p) for p in ["/d1", "/d2"]],
                     strategy=NativeMove(rename=_tree_rename(files, dirs)),
                     stat=stat,
                     flags=MvFlags(no_target_dir=True, backup="simple"),
                     readdir=_dir_readdir(files, dirs))
    assert io.exit_code == 0
    assert io.stderr is None
    assert files["/d2/x.txt"] == b"X"
    assert files["/d2~/y.txt"] == b"Y"


@pytest.mark.asyncio
async def test_no_target_dir_backup_none_still_refuses_nonempty():
    # --backup=none displaces nothing, so the refusal must still apply.
    files = {"/d1/x.txt": b"X", "/d2/y.txt": b"Y"}
    dirs = {"/d1", "/d2"}
    _, io = await _run(files,
                       dirs, ["/d1", "/d2"],
                       readdir=_dir_readdir(files, dirs),
                       flags=MvFlags(no_target_dir=True, backup="none"))
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

    _, io = await _run(files,
                       dirs, ["/d1", "/d2"],
                       readdir=failing_readdir,
                       flags=MvFlags(no_target_dir=True))
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot overwrite '/d2': "
                         b"Operation not supported\n")
    assert files["/d2/y.txt"] == b"Y"


@pytest.mark.asyncio
async def test_primitive_directory_target_backup_transfers_the_tree():
    # A cross-mount mv -b -T has a directory target: read_bytes cannot copy
    # it, so the backup walks the tree entry by entry.
    files = {"/src/x.txt": b"X", "/d/y.txt": b"Y", "/d/sub/z.txt": b"Z"}
    dirs = {"/src", "/d", "/d/sub"}
    _, io = await _run_primitive(files,
                                 dirs, ["/src", "/d"],
                                 flags=MvFlags(no_target_dir=True,
                                               backup="simple"))
    assert io.exit_code == 0
    assert io.stderr is None
    assert files["/d~/y.txt"] == b"Y"
    assert files["/d~/sub/z.txt"] == b"Z"
    assert files["/d/x.txt"] == b"X"
