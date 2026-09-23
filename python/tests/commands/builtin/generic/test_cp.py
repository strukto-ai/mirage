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

from mirage.commands.builtin.generic.cp import CpFlags, cp, update_mode
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.types import (ContentType, FileStat, FileType, NativeCopy,
                          PathSpec, PrimitiveCopy)
from mirage.utils.errors import enotsup


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path, directory=path, vfs_path=path.strip("/"))


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
                            type=FileType.FILE,
                            content=ContentType.TEXT,
                            modified=stamps.get(k))
        raise FileNotFoundError(k)

    async def copy(src, dst) -> None:
        files[_key(dst)] = files[_key(src)]

    async def find(p, type=None) -> list[str]:
        base = _key(p) + "/"
        return sorted(k for k in files if k.startswith(base))

    return stat, copy, find


async def _run(files, dirs, paths, *, mtimes=None, readdir=None, **kw):
    stat, copy, find = _make_backend(files, dirs, mtimes)
    flags = kw.pop("flags", None) or CpFlags(
        recursive=kw.get("recursive", False),
        no_clobber=kw.get("no_clobber", False),
        verbose=kw.get("verbose", False))
    return await cp([_spec(p) for p in paths],
                    strategy=NativeCopy(copy=copy, find=find),
                    stat=stat,
                    flags=flags,
                    readdir=readdir)


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
    await _run(files, {"/d"}, ["/a.txt", "/d"], no_clobber=True)
    assert files["/d/a.txt"] == b"OLD"


@pytest.mark.asyncio
async def test_no_clobber_duplicate_basenames_first_wins():
    files = {"/x/a.txt": b"FIRST", "/y/a.txt": b"SECOND", "/d/keep": b"K"}
    await _run(files, {"/d"}, ["/x/a.txt", "/y/a.txt", "/d"], no_clobber=True)
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
    out, _ = await _run(files, set(), ["/a.txt", "/copy.txt"], verbose=True)
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
                     flags=CpFlags())
    assert files["/copy.txt"] == b"AAA"
    assert io.reads == {"/a.txt": b"AAA"}
    assert io.cache == ["/a.txt"]


@pytest.mark.asyncio
async def test_native_copy_records_no_reads():
    files = {"/a.txt": b"AAA"}
    _, io = await _run(files, set(), ["/a.txt", "/copy.txt"])
    assert io.reads == {}
    assert io.cache == []


def _make_primitive(files: dict[str, bytes],
                    dirs: set[str],
                    *,
                    read_fails: dict | None = None,
                    write_fails: dict | None = None,
                    readdir_fails: dict | None = None):
    stat, _, _ = _make_backend(files, dirs)
    read_err = read_fails or {}
    write_err = write_fails or {}
    readdir_err = readdir_fails or {}

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
        if _key(p) in readdir_err:
            raise readdir_err[_key(p)]
        base = _key(p) + "/"
        children = {
            base + k[len(base):].split("/", 1)[0]
            for k in set(files) | dirs if k.startswith(base)
        }
        return sorted(children)

    strategy = PrimitiveCopy(read_bytes=read_bytes,
                             write=write,
                             mkdir=mkdir,
                             readdir=readdir)
    return stat, strategy


async def _run_primitive(files,
                         dirs,
                         paths,
                         *,
                         recursive=False,
                         flags=None,
                         **fail_kw):
    stat, strategy = _make_primitive(files, dirs, **fail_kw)
    return await cp([_spec(p) for p in paths],
                    strategy=strategy,
                    stat=stat,
                    flags=flags or CpFlags(recursive=recursive))


@pytest.mark.asyncio
async def test_primitive_read_failure_reports_cannot_open():
    files = {"/src/a.txt": b"AAA", "/src/b.txt": b"BBB", "/d/keep": b"K"}
    _, io = await _run_primitive(
        files, {"/src", "/d"}, ["/src/a.txt", "/src/b.txt", "/d"],
        read_fails={"/src/a.txt": PermissionError("/src/a.txt")})
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot open '/src/a.txt' for reading: "
                         b"Permission denied\n")
    assert "/d/a.txt" not in files
    assert files["/d/b.txt"] == b"BBB"


@pytest.mark.asyncio
async def test_primitive_write_failure_reports_cannot_create():
    files = {"/src/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run_primitive(
        files, {"/src", "/d"}, ["/src/a.txt", "/d"],
        write_fails={"/d/a.txt": enotsup("notion", "write", "/d/a.txt")})
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot create regular file '/d/a.txt': "
                         b"Operation not supported\n")
    assert files["/src/a.txt"] == b"AAA"
    assert io.reads == {}


@pytest.mark.asyncio
async def test_primitive_recursive_read_failure_copies_rest():
    files = {"/src/t/a.txt": b"A", "/src/t/nr.txt": b"NR"}
    dirs = {"/src", "/src/t", "/d"}
    _, io = await _run_primitive(
        files,
        dirs, ["/src/t", "/d/t"],
        recursive=True,
        read_fails={"/src/t/nr.txt": PermissionError("/src/t/nr.txt")})
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot open '/src/t/nr.txt' for reading: "
                         b"Permission denied\n")
    assert files["/d/t/a.txt"] == b"A"
    assert "/d/t/nr.txt" not in files


_OLD = "2020-01-01T00:00:00+00:00"
_NEW = "2024-01-01T00:00:00+00:00"


def _root_readdir(files, dirs):

    async def readdir(p) -> list[str]:
        base = _key(p) + "/" if _key(p) != "/" else "/"
        children = {
            base + k[len(base):].split("/", 1)[0]
            for k in set(files) | dirs if k.startswith(base) and k != _key(p)
        }
        return sorted(children)

    return readdir


@pytest.mark.asyncio
async def test_update_older_skips_newer_dest():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       mtimes={
                           "/a.txt": _OLD,
                           "/b.txt": _NEW
                       },
                       flags=CpFlags(update="older"))
    assert io.exit_code == 0
    assert io.stderr is None
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
               flags=CpFlags(update="older"))
    assert files["/b.txt"] == b"SRC"


@pytest.mark.asyncio
async def test_update_older_equal_mtime_skips():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       mtimes={
                           "/a.txt": _OLD,
                           "/b.txt": _OLD
                       },
                       flags=CpFlags(update="older"))
    assert io.exit_code == 0
    assert files["/b.txt"] == b"DST"


@pytest.mark.asyncio
async def test_update_older_unknown_mtime_replaces():
    # Freshness cannot be proven without mtimes: the copy proceeds.
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    await _run(files,
               set(), ["/a.txt", "/b.txt"],
               flags=CpFlags(update="older"))
    assert files["/b.txt"] == b"SRC"


@pytest.mark.asyncio
async def test_update_none_skips_silently():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       flags=CpFlags(update="none"))
    assert io.exit_code == 0
    assert io.stderr is None
    assert files["/b.txt"] == b"DST"


@pytest.mark.asyncio
async def test_update_none_fail_reports_not_replacing():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       flags=CpFlags(update="none-fail"))
    assert io.exit_code == 1
    assert io.stderr == b"cp: not replacing '/b.txt'\n"
    assert files["/b.txt"] == b"DST"


@pytest.mark.asyncio
async def test_backup_simple_saves_old_dest():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    await _run(files,
               set(), ["/a.txt", "/b.txt"],
               flags=CpFlags(backup="simple"))
    assert files["/b.txt"] == b"SRC"
    assert files["/b.txt~"] == b"DST"


@pytest.mark.asyncio
async def test_backup_skips_missing_dest():
    files = {"/a.txt": b"SRC"}
    await _run(files,
               set(), ["/a.txt", "/b.txt"],
               flags=CpFlags(backup="existing"))
    assert files["/b.txt"] == b"SRC"
    assert "/b.txt~" not in files


@pytest.mark.asyncio
async def test_backup_existing_prefers_numbered_versions():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST", "/b.txt.~3~": b"V3"}
    await _run(files,
               set(), ["/a.txt", "/b.txt"],
               readdir=_root_readdir(files, set()),
               flags=CpFlags(backup="existing"))
    assert files["/b.txt.~4~"] == b"DST"


@pytest.mark.asyncio
async def test_backup_numbered_starts_at_one():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    await _run(files,
               set(), ["/a.txt", "/b.txt"],
               readdir=_root_readdir(files, set()),
               flags=CpFlags(backup="numbered"))
    assert files["/b.txt.~1~"] == b"DST"


@pytest.mark.asyncio
async def test_backup_custom_suffix():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    await _run(files,
               set(), ["/a.txt", "/b.txt"],
               flags=CpFlags(backup="simple", suffix=".bak"))
    assert files["/b.txt.bak"] == b"DST"


@pytest.mark.asyncio
async def test_backup_records_write():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       flags=CpFlags(backup="simple"))
    assert set(io.writes) == {"/b.txt", "/b.txt~"}


@pytest.mark.asyncio
async def test_verbose_backup_annotation():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    out, _ = await _run(files,
                        set(), ["/a.txt", "/b.txt"],
                        flags=CpFlags(verbose=True, backup="simple"))
    assert out == b"'/a.txt' -> '/b.txt' (backup: '/b.txt~')\n"


@pytest.mark.asyncio
async def test_recursive_merge_backs_up_per_entry():
    files = {"/src/f.txt": b"SRC", "/d/src/f.txt": b"DST"}
    dirs = {"/src", "/d", "/d/src"}
    out, _ = await _run_primitive(files,
                                  dirs, ["/src", "/d"],
                                  recursive=True,
                                  flags=CpFlags(recursive=True,
                                                verbose=True,
                                                backup="simple"))
    assert files["/d/src/f.txt~"] == b"DST"
    assert files["/d/src/f.txt"] == b"SRC"


@pytest.mark.asyncio
async def test_target_dir_copies_into():
    files = {"/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/a.txt"],
                       flags=CpFlags(target_dir="/d"))
    assert io.exit_code == 0
    assert files["/d/a.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_target_dir_missing_fails_whole_command():
    files = {"/a.txt": b"AAA"}
    _, io = await _run(files,
                       set(), ["/a.txt"],
                       flags=CpFlags(target_dir="/nosuch"))
    assert io.exit_code == 1
    assert io.stderr == (b"cp: target directory '/nosuch': "
                         b"No such file or directory\n")
    assert set(files) == {"/a.txt"}


@pytest.mark.asyncio
async def test_target_dir_not_a_directory():
    files = {"/a.txt": b"AAA", "/f.txt": b"F"}
    _, io = await _run(files,
                       set(), ["/a.txt"],
                       flags=CpFlags(target_dir="/f.txt"))
    assert io.exit_code == 1
    assert io.stderr == b"cp: target directory '/f.txt': Not a directory\n"


@pytest.mark.asyncio
async def test_no_target_dir_extra_operand():
    from mirage.commands.errors import UsageError
    files = {"/a.txt": b"A", "/b.txt": b"B", "/c.txt": b"C"}
    with pytest.raises(UsageError) as exc:
        await _run(files,
                   set(), ["/a.txt", "/b.txt", "/c.txt"],
                   flags=CpFlags(no_target_dir=True))
    assert "cp: extra operand '/c.txt'" in str(exc.value)


@pytest.mark.asyncio
async def test_no_target_dir_refuses_dir_dest_for_file():
    files = {"/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/a.txt", "/d"],
                       flags=CpFlags(no_target_dir=True))
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot overwrite directory '/d' with "
                         b"non-directory '/a.txt'\n")


@pytest.mark.asyncio
async def test_overwrite_nondir_with_dir_refused():
    files = {"/f.txt": b"F", "/d/x.txt": b"X"}
    _, io = await _run(files, {"/d"}, ["/d", "/f.txt"], recursive=True)
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot overwrite non-directory '/f.txt' "
                         b"with directory '/d'\n")


@pytest.mark.asyncio
async def test_missing_operands_raise_usage_errors():
    from mirage.commands.errors import UsageError
    with pytest.raises(UsageError) as exc:
        await _run({}, set(), [])
    assert "cp: missing file operand" in str(exc.value)
    with pytest.raises(UsageError) as exc:
        await _run({"/a.txt": b"A"}, set(), ["/a.txt"])
    assert "missing destination file operand after '/a.txt'" in str(exc.value)


def test_parse_cp_flags_conflicts_and_grammar():
    from mirage.commands.builtin.generic.cp import parse_flags
    from mirage.commands.errors import UsageError
    from mirage.commands.spec import SPECS
    from mirage.commands.spec.flag_view import FlagView

    def view(bag):
        return FlagView(bag, spec=SPECS["cp"])

    with pytest.raises(UsageError) as exc:
        parse_flags(view({"backup": True, "no_clobber": True}))
    assert "cp: --backup is mutually exclusive with -n or " \
           "--update=none-fail" in str(exc.value)
    with pytest.raises(UsageError) as exc:
        parse_flags(view({"backup": True, "update": "none-fail"}))
    assert "mutually exclusive" in str(exc.value)
    with pytest.raises(UsageError) as exc:
        parse_flags(
            view({
                "target_directory": "/d",
                "no_target_directory": True
            }))
    assert "cannot combine --target-directory (-t) and " \
           "--no-target-directory (-T)" in str(exc.value)
    with pytest.raises(UsageError) as exc:
        parse_flags(view({"update": "bogus"}))
    assert "invalid argument 'bogus' for '--update'" in str(exc.value)
    with pytest.raises(UsageError) as exc:
        parse_flags(view({"backup": "bogus"}))
    assert "invalid argument 'bogus' for 'backup type'" in str(exc.value)
    assert parse_flags(view({"update": True})).update == "older"
    assert parse_flags(view({"update": True})).update == "older"
    assert parse_flags(view({"update": "all"})).update == "all"
    assert parse_flags(view({})).update is None
    parsed = parse_flags(view({"suffix": ".bak"}))
    assert parsed.backup == "existing"
    assert parsed.suffix == ".bak"
    # GNU 9.7: `cp --backup --suffix= f g` writes g~, so an empty suffix
    # reads as absent rather than naming the original as its own backup.
    assert parse_flags(view({"backup": True, "suffix": ""})).suffix == "~"
    assert parse_flags(view({"backup": "t"})).backup == "numbered"
    assert parse_flags(view({"backup": "nil"})).backup == "existing"
    assert parse_flags(view({"archive": True})).recursive is True


def _typed_backend(files: dict[str, bytes], dirs: set[str]):
    """Backend whose ``find`` honors ``type`` and whose ``mkdir`` records."""
    stat, copy, _ = _make_backend(files, dirs)

    async def find(p, type=None) -> list[str]:
        base = _key(p) + "/"
        if type == "d":
            return sorted(k for k in dirs if k.startswith(base))
        return sorted(k for k in files if k.startswith(base))

    async def mkdir(p) -> None:
        dirs.add(_key(p))

    return stat, copy, find, mkdir


@pytest.mark.asyncio
async def test_recursive_update_keeps_directories_without_files():
    # The per-entry policy path cannot use dir_copy, so it must recreate the
    # tree's directories itself; GNU keeps an empty directory.
    files = {"/t/f.txt": b"F"}
    dirs = {"/t", "/t/empt"}
    stat, copy, find, mkdir = _typed_backend(files, dirs)
    _, io = await cp([_spec(p) for p in ["/t", "/c"]],
                     strategy=NativeCopy(copy=copy, find=find, mkdir=mkdir),
                     stat=stat,
                     flags=CpFlags(recursive=True, update="older"))
    assert io.exit_code == 0
    assert files["/c/f.txt"] == b"F"
    assert "/c/empt" in dirs


@pytest.mark.asyncio
async def test_recursive_empty_tree_still_creates_destination():
    files: dict[str, bytes] = {}
    dirs = {"/t", "/t/a", "/t/a/b"}
    stat, copy, find, mkdir = _typed_backend(files, dirs)
    _, io = await cp([_spec(p) for p in ["/t", "/c"]],
                     strategy=NativeCopy(copy=copy, find=find, mkdir=mkdir),
                     stat=stat,
                     flags=CpFlags(recursive=True, backup="simple"))
    assert io.exit_code == 0
    assert {"/c", "/c/a", "/c/a/b"} <= dirs


@pytest.mark.asyncio
async def test_no_op_policy_modes_keep_the_native_dir_copy():
    # --update=all and --backup=none decide nothing per entry, so the fast
    # whole-tree dir_copy must still be used.
    for flags in (CpFlags(recursive=True,
                          update="all"), CpFlags(recursive=True,
                                                 backup="none")):
        files = {"/t/f.txt": b"F"}
        dirs = {"/t", "/t/empt"}
        stat, copy, find, mkdir = _typed_backend(files, dirs)
        used = {"dir_copy": False}

        async def dir_copy(src, dst) -> None:
            used["dir_copy"] = True
            dirs.add(_key(dst))

        _, io = await cp([_spec(p) for p in ["/t", "/c"]],
                         strategy=NativeCopy(copy=copy,
                                             find=find,
                                             dir_copy=dir_copy,
                                             mkdir=mkdir),
                         stat=stat,
                         flags=flags)
        assert io.exit_code == 0
        assert used["dir_copy"], flags


@pytest.mark.asyncio
async def test_backup_version_scan_failure_aborts_the_overwrite():
    # Reading a failed listing as "no numbered backups" would pick .~1~ and
    # overwrite backup history, so the transfer must abort instead.
    files = {"/a.txt": b"NEW", "/b.txt": b"OLD"}

    async def failing_readdir(p) -> list[str]:
        raise enotsup("ram", "readdir", p)

    _, io = await _run(files,
                       set(), ["/a.txt", "/b.txt"],
                       readdir=failing_readdir,
                       flags=CpFlags(backup="numbered"))
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot backup '/b.txt': "
                         b"Operation not supported\n")
    assert files["/b.txt"] == b"OLD"


@pytest.mark.asyncio
async def test_primitive_recursive_walk_names_a_directory_it_may_not_open():
    # GNU: "cp: cannot access 'X': Permission denied" for a directory it
    # could not read, the directory itself still created, the rest of
    # the tree copied, exit 1.
    files = {"/src/a.txt": b"A", "/src/sealed/s": b"S", "/src/sub/b": b"B"}
    dirs = {"/src", "/src/sealed", "/src/sub"}
    _, io = await _run_primitive(
        files,
        dirs, ["/src", "/dst"],
        recursive=True,
        readdir_fails={"/src/sealed": PermissionError("/src/sealed")})
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot access '/src/sealed': "
                         b"Permission denied\n")
    assert files["/dst/a.txt"] == b"A" and files["/dst/sub/b"] == b"B"
    assert "/dst/sealed" in dirs and "/dst/sealed/s" not in files


# Both of cp's argument clauses name the refused word through gnulib's
# quote(), so a byte outside 0x20-0x7e comes back escaped rather than
# interpolated raw. Rows measured against GNU coreutils 9.4 under
# `LC_ALL=C` with a raw `bytes` argv (`cp --update=<w>`,
# `cp --backup=<w>`). Mirrored in cp.test.ts.
QUOTED_WORDS = [
    ("xé", r"x\303\251"),
    ("x\r", r"x\r"),
    ("x\x01", r"x\001"),
    ("x\x7f", r"x\177"),
    ("x'", r"x\'"),
    ("x\\", r"x\\"),
]


@pytest.mark.parametrize("value,escaped", QUOTED_WORDS)
def test_update_clause_quotes_the_word(value, escaped):
    from mirage.commands.builtin.generic.cp import parse_flags
    from mirage.commands.errors import UsageError
    from mirage.commands.spec import SPECS
    from mirage.commands.spec.flag_view import FlagView

    with pytest.raises(UsageError) as exc:
        parse_flags(FlagView({"update": value}, spec=SPECS["cp"]))
    assert str(exc.value).startswith(
        f"cp: invalid argument '{escaped}' for '--update'\n")
    assert exc.value.exit_code == 1


@pytest.mark.parametrize("value,escaped", QUOTED_WORDS)
def test_backup_clause_quotes_the_word(value, escaped):
    from mirage.commands.builtin.generic.cp import parse_flags
    from mirage.commands.errors import UsageError
    from mirage.commands.spec import SPECS
    from mirage.commands.spec.flag_view import FlagView

    with pytest.raises(UsageError) as exc:
        parse_flags(FlagView({"backup": value}, spec=SPECS["cp"]))
    assert str(exc.value).startswith(
        f"cp: invalid argument '{escaped}' for 'backup type'\n")
    assert exc.value.exit_code == 1


# Measured against GNU coreutils 9.7 on debian:stable-slim, LC_ALL=C.
@pytest.mark.parametrize("command", ["cp", "mv"])
@pytest.mark.parametrize("value,kind", [("x", "invalid"), ("", "ambiguous")])
def test_update_lists_gnu_candidates(command, value, kind):
    with pytest.raises(UsageError) as exc:
        update_mode(command, FlagView({"update": value}, spec=SPECS[command]))
    assert str(
        exc.value) == (f"{command}: {kind} argument '{value}' for '--update'\n"
                       "Valid arguments are:\n"
                       "  - 'all'\n  - 'none'\n  - 'none-fail'\n  - 'older'\n"
                       f"Try '{command} --help' for more information.")
    assert exc.value.exit_code == 1


@pytest.mark.parametrize("command", ["cp", "mv"])
@pytest.mark.parametrize("value", ["all", "none", "none-fail", "older"])
def test_update_accepts_each_advertised_candidate(command, value):
    assert update_mode(command, FlagView({"update": value},
                                         spec=SPECS[command])) == value


# Measured against GNU coreutils 9.7 on debian:stable-slim, LC_ALL=C.
@pytest.mark.parametrize("command", ["cp", "mv"])
@pytest.mark.parametrize("value,mode", [
    ("a", "all"),
    ("al", "all"),
    ("o", "older"),
    ("old", "older"),
    ("none-", "none-fail"),
])
def test_update_accepts_an_unambiguous_prefix(command, value, mode):
    assert update_mode(command, FlagView({"update": value},
                                         spec=SPECS[command])) == mode


# `n` is a prefix of `none` and of `none-fail`, which are two values, so
# 9.7 refuses it rather than reading it as `none`.
@pytest.mark.parametrize("command", ["cp", "mv"])
@pytest.mark.parametrize("value", ["n", "no", "non"])
def test_update_refuses_a_prefix_spanning_two_values(command, value):
    with pytest.raises(UsageError) as exc:
        update_mode(command, FlagView({"update": value}, spec=SPECS[command]))
    assert str(exc.value).startswith(
        f"{command}: ambiguous argument '{value}' for '--update'\n")
    assert exc.value.exit_code == 1


def _slashed(path: str) -> PathSpec:
    # The operand as the shell classifies `path/`: a normalized virtual
    # path with the typed spelling, slash included, kept in raw_path.
    return PathSpec(virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/",
                    vfs_path=path.strip("/"),
                    raw_path=path + "/")


@pytest.mark.asyncio
async def test_slashed_missing_destination_refuses_a_file_source():
    # GNU 9.7: `cp a.txt missing/` is `cannot create regular file
    # 'missing/': Not a directory`, and nothing named `missing` appears.
    files = {"/a.txt": b"AAA"}
    stat, copy, find = _make_backend(files, set())
    _, io = await cp([_spec("/a.txt"), _slashed("/missing")],
                     strategy=NativeCopy(copy=copy, find=find),
                     stat=stat,
                     flags=CpFlags())
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot create regular file '/missing/': "
                         b"Not a directory\n")
    assert files == {"/a.txt": b"AAA"}


@pytest.mark.asyncio
async def test_many_sources_to_a_slashed_file_report_not_a_directory():
    # GNU 9.7: `cp a b reg/` is `target 'reg/': Not a directory`, the
    # destination probe's verdict, where only a genuinely absent target
    # is `No such file or directory`.
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB", "/reg": b"R"}
    stat, copy, find = _make_backend(files, set())
    with pytest.raises(NotADirectoryError, match="target '/reg/'"):
        await cp([_spec("/a.txt"),
                  _spec("/b.txt"),
                  _slashed("/reg")],
                 strategy=NativeCopy(copy=copy, find=find),
                 stat=stat,
                 flags=CpFlags())
    with pytest.raises(FileNotFoundError, match="target '/missing/'"):
        await cp([_spec("/a.txt"),
                  _spec("/b.txt"),
                  _slashed("/missing")],
                 strategy=NativeCopy(copy=copy, find=find),
                 stat=stat,
                 flags=CpFlags())
    assert files == {"/a.txt": b"AAA", "/b.txt": b"BBB", "/reg": b"R"}


@pytest.mark.asyncio
async def test_slashed_missing_destination_takes_a_directory_source():
    files = {"/d/f": b"F"}
    stat, copy, find = _make_backend(files, {"/d"})
    _, io = await cp([_spec("/d"), _slashed("/missing")],
                     strategy=NativeCopy(copy=copy, find=find),
                     stat=stat,
                     flags=CpFlags(recursive=True))
    assert io.exit_code == 0
    assert files["/missing/f"] == b"F"


@pytest.mark.asyncio
async def test_slashed_file_destination_reports_cannot_stat():
    # `cp a.txt reg/` fails the destination's stat in GNU, and the stat
    # itself decides here whether or not the backend's is slash-aware.
    files = {"/a.txt": b"AAA", "/reg": b"R"}
    stat, copy, find = _make_backend(files, set())
    _, io = await cp([_spec("/a.txt"), _slashed("/reg")],
                     strategy=NativeCopy(copy=copy, find=find),
                     stat=stat,
                     flags=CpFlags())
    assert io.exit_code == 1
    assert io.stderr == b"cp: cannot stat '/reg/': Not a directory\n"
    assert files == {"/a.txt": b"AAA", "/reg": b"R"}


@pytest.mark.asyncio
async def test_slashed_file_source_reports_cannot_stat():
    files = {"/reg": b"R"}
    stat, copy, find = _make_backend(files, set())
    _, io = await cp([_slashed("/reg"), _spec("/x")],
                     strategy=NativeCopy(copy=copy, find=find),
                     stat=stat,
                     flags=CpFlags())
    assert io.exit_code == 1
    assert io.stderr == b"cp: cannot stat '/reg/': Not a directory\n"
    assert files == {"/reg": b"R"}
