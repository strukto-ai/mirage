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

from mirage.commands.builtin.generic.cp import (
    CpFlags,
    TransferLinks,
    cp_generic,
    parse_flags,
    update_mode,
)
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.fs import enotsup
from mirage.io.types import IOResult
from mirage.ops.types import LinkView
from mirage.types import (
    LINK_TARGET_KEY,
    ContentType,
    CopyDeref,
    FileStat,
    FileType,
    MountMode,
    NativeCopy,
    PathSpec,
    PrimitiveCopy,
)
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path, directory=path, vfs_path=path.strip("/"))


def _key(p) -> str:
    return (p.virtual if isinstance(p, PathSpec) else p).rstrip("/")


def _make_backend(
    files: dict[str, bytes],
    dirs: set[str],
    mtimes: dict[str, str] | None = None,
):
    stamps = mtimes or {}

    async def stat(p) -> FileStat:
        k = _key(p)
        if k in dirs:
            return FileStat(name=k.rsplit("/", 1)[-1], type=FileType.DIRECTORY)
        if k in files:
            return FileStat(
                name=k.rsplit("/", 1)[-1],
                type=FileType.FILE,
                content=ContentType.TEXT,
                modified=stamps.get(k),
            )
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
        verbose=kw.get("verbose", False),
    )
    return await cp_generic(
        [_spec(p) for p in paths],
        strategy=NativeCopy(copy=copy, find=find),
        stat=stat,
        flags=flags,
        readdir=readdir,
    )


@pytest.mark.asyncio
async def test_multiple_sources_nondir_raises():
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB", "/dst.txt": b"DST"}
    with pytest.raises(NotADirectoryError):
        await _run(files, set(), ["/a.txt", "/b.txt", "/dst.txt"])
    assert files["/dst.txt"] == b"DST"


@pytest.mark.asyncio
async def test_no_clobber_duplicate_basenames_first_wins():
    files = {"/x/a.txt": b"FIRST", "/y/a.txt": b"SECOND", "/d/keep": b"K"}
    await _run(files, {"/d"}, ["/x/a.txt", "/y/a.txt", "/d"], no_clobber=True)
    assert files["/d/a.txt"] == b"FIRST"


@pytest.mark.asyncio
async def test_duplicate_basenames_keep_the_first_copy():
    files = {"/x/a.txt": b"FIRST", "/y/a.txt": b"SECOND", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/x/a.txt", "/y/a.txt", "/d"])
    assert files["/d/a.txt"] == b"FIRST"
    assert (io.exit_code, io.stderr) == (
        1,
        b"cp: will not overwrite just-created '/d/a.txt' with '/y/a.txt'\n",
    )


@pytest.mark.asyncio
async def test_records_writes_by_strip_prefix():
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/a.txt", "/b.txt", "/d"])
    assert set(io.writes) == {"/d/a.txt", "/d/b.txt"}


@pytest.mark.asyncio
async def test_same_file_via_directory_target_errors():
    files = {"/d/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run(files, {"/d"}, ["/d/a.txt", "/d"])
    assert io.exit_code == 1
    assert b"are the same file" in io.stderr
    assert files["/d/a.txt"] == b"AAA"


@pytest.mark.asyncio
async def test_recursive_into_nested_subtree_refused():
    files = {"/d/a.txt": b"AAA"}
    _, io = await _run(
        files, {"/d", "/d/sub"}, ["/d", "/d/sub"], recursive=True
    )
    assert io.exit_code == 1
    assert b"into itself" in io.stderr
    assert set(files) == {"/d/a.txt", "/d/sub/d/a.txt"}


@pytest.mark.asyncio
async def test_primitive_copy_records_source_reads():
    files = {"/a.txt": b"AAA"}
    stat, _, _ = _make_backend(files, set())

    async def read_bytes(p) -> bytes:
        return files[_key(p)]

    async def write(p, data: bytes) -> None:
        files[_key(p)] = data

    _, io = await cp_generic(
        [_spec("/a.txt"), _spec("/copy.txt")],
        stat=stat,
        strategy=PrimitiveCopy(
            read_bytes=read_bytes, write=write, mkdir=write, readdir=write
        ),
        flags=CpFlags(),
    )
    assert files["/copy.txt"] == b"AAA"
    assert io.reads == {"/a.txt": b"AAA"}
    assert io.cache == ["/a.txt"]


@pytest.mark.asyncio
async def test_native_copy_records_no_reads():
    files = {"/a.txt": b"AAA"}
    _, io = await _run(files, set(), ["/a.txt", "/copy.txt"])
    assert io.reads == {}
    assert io.cache == []


def _make_primitive(
    files: dict[str, bytes],
    dirs: set[str],
    *,
    read_fails: dict | None = None,
    write_fails: dict | None = None,
    readdir_fails: dict | None = None,
):
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
            base + k[len(base) :].split("/", 1)[0]
            for k in set(files) | dirs
            if k.startswith(base)
        }
        return sorted(children)

    strategy = PrimitiveCopy(
        read_bytes=read_bytes, write=write, mkdir=mkdir, readdir=readdir
    )
    return stat, strategy


async def _run_primitive(
    files, dirs, paths, *, recursive=False, flags=None, **fail_kw
):
    stat, strategy = _make_primitive(files, dirs, **fail_kw)
    return await cp_generic(
        [_spec(p) for p in paths],
        strategy=strategy,
        stat=stat,
        flags=flags or CpFlags(recursive=recursive),
    )


@pytest.mark.asyncio
async def test_primitive_read_failure_reports_cannot_open():
    files = {"/src/a.txt": b"AAA", "/src/b.txt": b"BBB", "/d/keep": b"K"}
    _, io = await _run_primitive(
        files,
        {"/src", "/d"},
        ["/src/a.txt", "/src/b.txt", "/d"],
        read_fails={"/src/a.txt": PermissionError("/src/a.txt")},
    )
    assert io.exit_code == 1
    assert io.stderr == (
        b"cp: cannot open '/src/a.txt' for reading: Permission denied\n"
    )
    assert "/d/a.txt" not in files
    assert files["/d/b.txt"] == b"BBB"


@pytest.mark.asyncio
async def test_primitive_write_failure_reports_cannot_create():
    files = {"/src/a.txt": b"AAA", "/d/keep": b"K"}
    _, io = await _run_primitive(
        files,
        {"/src", "/d"},
        ["/src/a.txt", "/d"],
        write_fails={"/d/a.txt": enotsup("notion", "write", "/d/a.txt")},
    )
    assert io.exit_code == 1
    assert io.stderr == (
        b"cp: cannot create regular file '/d/a.txt': Operation not supported\n"
    )
    assert files["/src/a.txt"] == b"AAA"
    assert io.reads == {}


@pytest.mark.asyncio
async def test_primitive_recursive_read_failure_copies_rest():
    files = {"/src/t/a.txt": b"A", "/src/t/nr.txt": b"NR"}
    dirs = {"/src", "/src/t", "/d"}
    _, io = await _run_primitive(
        files,
        dirs,
        ["/src/t", "/d/t"],
        recursive=True,
        read_fails={"/src/t/nr.txt": PermissionError("/src/t/nr.txt")},
    )
    assert io.exit_code == 1
    assert io.stderr == (
        b"cp: cannot open '/src/t/nr.txt' for reading: Permission denied\n"
    )
    assert files["/d/t/a.txt"] == b"A"
    assert "/d/t/nr.txt" not in files


_OLD = "2020-01-01T00:00:00+00:00"


def _root_readdir(files, dirs):
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
@pytest.mark.parametrize(
    "update,mtimes,kept",
    [
        ("older", {"/a.txt": _OLD, "/b.txt": _OLD}, b"DST"),
        ("older", None, b"SRC"),
        ("none", None, b"DST"),
    ],
)
async def test_update_skips_only_a_destination_it_can_prove_fresh(
    update, mtimes, kept
):
    # Freshness cannot be proven without mtimes: the copy proceeds.
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    _, io = await _run(
        files,
        set(),
        ["/a.txt", "/b.txt"],
        mtimes=mtimes,
        flags=CpFlags(update=update),
    )
    assert (io.exit_code, io.stderr) == (0, None)
    assert files["/b.txt"] == kept


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "before,backups",
    [
        ({}, {}),
        (
            {"/b.txt": b"DST", "/b.txt.~3~": b"V3"},
            {"/b.txt.~3~": b"V3", "/b.txt.~4~": b"DST"},
        ),
    ],
)
async def test_backup_existing_follows_the_numbered_versions(before, backups):
    files = {"/a.txt": b"SRC", **before}
    await _run(
        files,
        set(),
        ["/a.txt", "/b.txt"],
        readdir=_root_readdir(files, set()),
        flags=CpFlags(backup="existing"),
    )
    assert files == {"/a.txt": b"SRC", "/b.txt": b"SRC", **backups}


@pytest.mark.asyncio
async def test_backup_records_write():
    files = {"/a.txt": b"SRC", "/b.txt": b"DST"}
    _, io = await _run(
        files, set(), ["/a.txt", "/b.txt"], flags=CpFlags(backup="simple")
    )
    assert set(io.writes) == {"/b.txt", "/b.txt~"}


@pytest.mark.asyncio
async def test_recursive_merge_backs_up_per_entry():
    files = {"/src/f.txt": b"SRC", "/d/src/f.txt": b"DST"}
    dirs = {"/src", "/d", "/d/src"}
    out, _ = await _run_primitive(
        files,
        dirs,
        ["/src", "/d"],
        recursive=True,
        flags=CpFlags(recursive=True, verbose=True, backup="simple"),
    )
    assert files["/d/src/f.txt~"] == b"DST"
    assert files["/d/src/f.txt"] == b"SRC"


@pytest.mark.asyncio
async def test_target_dir_not_a_directory():
    files = {"/a.txt": b"AAA", "/f.txt": b"F"}
    _, io = await _run(
        files,
        set(),
        ["/a.txt"],
        flags=CpFlags(target_dir=PathSpec.from_str_path("/f.txt")),
    )
    assert io.exit_code == 1
    assert io.stderr == b"cp: target directory '/f.txt': Not a directory\n"


@pytest.mark.asyncio
async def test_overwrite_nondir_with_dir_refused():
    files = {"/f.txt": b"F", "/d/x.txt": b"X"}
    _, io = await _run(files, {"/d"}, ["/d", "/f.txt"], recursive=True)
    assert io.exit_code == 1
    assert io.stderr == (
        b"cp: cannot overwrite non-directory '/f.txt' with directory '/d'\n"
    )


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
    def view(bag):
        return FlagView(bag, spec=SPECS["cp"])

    with pytest.raises(UsageError) as exc:
        parse_flags(view({"backup": True, "update": "none-fail"}))
    assert "mutually exclusive" in str(exc.value)
    assert parse_flags(view({})).update is None
    assert parse_flags(view({"backup": "t"})).backup == "numbered"
    assert parse_flags(view({"backup": "nil"})).backup == "existing"


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
async def test_recursive_empty_tree_still_creates_destination():
    files: dict[str, bytes] = {}
    dirs = {"/t", "/t/a", "/t/a/b"}
    stat, copy, find, mkdir = _typed_backend(files, dirs)
    _, io = await cp_generic(
        [_spec(p) for p in ["/t", "/c"]],
        strategy=NativeCopy(copy=copy, find=find, mkdir=mkdir),
        stat=stat,
        flags=CpFlags(recursive=True, backup="simple"),
    )
    assert io.exit_code == 0
    assert {"/c", "/c/a", "/c/a/b"} <= dirs


@pytest.mark.asyncio
async def test_no_op_policy_modes_keep_the_native_dir_copy():
    # --update=all and --backup=none decide nothing per entry, so the fast
    # whole-tree dir_copy must still be used.
    for flags in (
        CpFlags(recursive=True, update="all"),
        CpFlags(recursive=True, backup="none"),
    ):
        files = {"/t/f.txt": b"F"}
        dirs = {"/t", "/t/empt"}
        stat, copy, find, mkdir = _typed_backend(files, dirs)
        used = {"dir_copy": False}

        async def dir_copy(src, dst) -> None:
            used["dir_copy"] = True
            dirs.add(_key(dst))

        _, io = await cp_generic(
            [_spec(p) for p in ["/t", "/c"]],
            strategy=NativeCopy(
                copy=copy, find=find, dir_copy=dir_copy, mkdir=mkdir
            ),
            stat=stat,
            flags=flags,
        )
        assert io.exit_code == 0
        assert used["dir_copy"], flags


@pytest.mark.asyncio
async def test_backup_version_scan_failure_aborts_the_overwrite():
    # Reading a failed listing as "no numbered backups" would pick .~1~ and
    # overwrite backup history, so the transfer must abort instead.
    files = {"/a.txt": b"NEW", "/b.txt": b"OLD"}

    async def failing_readdir(p) -> list[str]:
        raise enotsup("ram", "readdir", p)

    _, io = await _run(
        files,
        set(),
        ["/a.txt", "/b.txt"],
        readdir=failing_readdir,
        flags=CpFlags(backup="numbered"),
    )
    assert io.exit_code == 1
    assert io.stderr == (
        b"cp: cannot backup '/b.txt': Operation not supported\n"
    )
    assert files["/b.txt"] == b"OLD"


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


@pytest.mark.parametrize(
    "flag,clause", [("update", "--update"), ("backup", "backup type")]
)
@pytest.mark.parametrize("value,escaped", QUOTED_WORDS)
def test_argument_clause_quotes_the_word(flag, clause, value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_flags(FlagView({flag: value}, spec=SPECS["cp"]))
    assert str(exc.value).startswith(
        f"cp: invalid argument '{escaped}' for '{clause}'\n"
    )
    assert exc.value.exit_code == 1


# Measured against GNU coreutils 9.7 on debian:stable-slim, LC_ALL=C.
@pytest.mark.parametrize(
    "command,value,mode",
    [
        ("cp", "older", "older"),
        ("cp", "a", "all"),
        ("cp", "o", "older"),
        ("cp", "old", "older"),
        ("mv", "all", "all"),
        ("mv", "older", "older"),
        ("mv", "a", "all"),
        ("mv", "al", "all"),
        ("mv", "o", "older"),
        ("mv", "old", "older"),
        ("mv", "none-", "none-fail"),
    ],
)
def test_update_accepts_a_mode_or_an_unambiguous_prefix(command, value, mode):
    assert (
        update_mode(command, FlagView({"update": value}, spec=SPECS[command]))
        == mode
    )


# `n` is a prefix of `none` and of `none-fail`, which are two values, so
# 9.7 refuses it rather than reading it as `none`.
@pytest.mark.parametrize("command", ["cp", "mv"])
@pytest.mark.parametrize("value", ["n", "no", "non"])
def test_update_refuses_a_prefix_spanning_two_values(command, value):
    with pytest.raises(UsageError) as exc:
        update_mode(command, FlagView({"update": value}, spec=SPECS[command]))
    assert str(exc.value).startswith(
        f"{command}: ambiguous argument '{value}' for '--update'\n"
    )
    assert exc.value.exit_code == 1


def _slashed(path: str) -> PathSpec:
    # The operand as the shell classifies `path/`: a normalized virtual
    # path with the typed spelling, slash included, kept in raw_path.
    return PathSpec(
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
        vfs_path=path.strip("/"),
        raw_path=path + "/",
    )


@pytest.mark.asyncio
async def test_many_sources_to_a_slashed_file_report_not_a_directory():
    # GNU 9.7: `cp a b reg/` is `target 'reg/': Not a directory`, the
    # destination probe's verdict, where only a genuinely absent target
    # is `No such file or directory`.
    files = {"/a.txt": b"AAA", "/b.txt": b"BBB", "/reg": b"R"}
    stat, copy, find = _make_backend(files, set())
    with pytest.raises(NotADirectoryError, match="target '/reg/'"):
        await cp_generic(
            [_spec("/a.txt"), _spec("/b.txt"), _slashed("/reg")],
            strategy=NativeCopy(copy=copy, find=find),
            stat=stat,
            flags=CpFlags(),
        )
    with pytest.raises(FileNotFoundError, match="target '/missing/'"):
        await cp_generic(
            [_spec("/a.txt"), _spec("/b.txt"), _slashed("/missing")],
            strategy=NativeCopy(copy=copy, find=find),
            stat=stat,
            flags=CpFlags(),
        )
    assert files == {"/a.txt": b"AAA", "/b.txt": b"BBB", "/reg": b"R"}


def _cp_flags(*argv: str) -> CpFlags:
    spec = SPECS["cp"]
    words = [*argv, "/data/a", "/data/b"]
    return parse_flags(
        FlagView(
            parse_to_kwargs(parse_command(spec, words, "/", "cp")), spec=spec
        )
    )


@pytest.mark.parametrize(
    "argv,deref",
    [
        (["-R"], CopyDeref.NEVER),
        (["-a"], CopyDeref.NEVER),
        (["-d"], CopyDeref.NEVER),
        (["-L", "-P"], CopyDeref.NEVER),
        (["-P", "-L"], CopyDeref.ALWAYS),
        (["-a", "-L"], CopyDeref.ALWAYS),
    ],
)
def test_the_last_link_option_wins_and_recursion_defaults_to_never(
    argv, deref
):
    # cp.c: -L, -P, -H, -d and -a each set the dereference policy, so the
    # last one wins; with none, a recursive copy copies links as links and
    # any other copy follows them.
    assert _cp_flags(*argv).dereference is deref


@pytest.mark.asyncio
async def test_a_link_reached_through_a_linked_directory_copies_as_a_link():
    # The table keys a link by its resolved directory, so `dl/al` stands
    # at `dir/al`; coreutils 9.7 copies the link itself.
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    await ws.shell(
        "cd /data && mkdir dir w && printf 'x\\n' > a.txt && "
        "ln -s ../a.txt dir/al && ln -s dir dl"
    )
    r = await ws.shell("cd /data && cp -P dl/al w/x && ls -F w")
    assert (r.exit_code, await r.materialize_stdout()) == (0, b"x@\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("native", [False, True])
@pytest.mark.parametrize("failure", ["read", "write", "partial-write"])
@pytest.mark.parametrize("referent", ["/safe", "/missing", "/dst~"])
async def test_failed_backup_restores_existing_link(native, failure, referent):
    files = {"/src": b"new", "/dst": b"old", "/safe": b"safe"}
    links = {"/dst~": referent}
    stat, _, find = _make_backend(files, set())

    async def read(path):
        if failure == "read" and path.virtual == "/dst":
            raise PermissionError("denied")
        return files[path.virtual]

    async def write(path, data):
        if path.virtual == "/dst~":
            if failure == "partial-write":
                files[path.virtual] = b"partial"
            raise PermissionError("denied")
        files[path.virtual] = data

    async def copy(src, dst):
        await write(dst, await read(src))

    async def dispatch(op, path, **kwargs):
        if op == "unlink":
            if path.virtual in links:
                del links[path.virtual]
            else:
                del files[path.virtual]
        elif op == "symlink":
            assert path.virtual not in files
            links[path.virtual] = kwargs["target"]
        else:
            raise AssertionError(op)
        return None, IOResult()

    async def readdir(path):
        return [p for p in (*files, *links) if p.startswith(path.virtual)]

    async def exists(path):
        return path in files

    async def target_stat(path):
        return await stat(_spec(links[path]))

    view = LinkView(
        stat_at=lambda path: (
            FileStat(
                name=path,
                type=FileType.SYMLINK,
                extra={LINK_TARGET_KEY: links[path]},
            )
            if path in links
            else None
        ),
        children=lambda path: [],
        subtree=lambda path: [],
        resolve=lambda path: links.get(path, path),
        exists=exists,
        target_stat=target_stat,
    )
    primitive = PrimitiveCopy(
        read_bytes=read, write=write, mkdir=readdir, readdir=readdir
    )
    strategy = NativeCopy(copy=copy, find=find) if native else primitive
    _, io = await cp_generic(
        [_spec("/src"), _spec("/dst")],
        stat=stat,
        strategy=strategy,
        flags=CpFlags(backup="simple"),
        copies=TransferLinks(view, dispatch, "/", primitive, stat),
    )
    assert io.exit_code == 1
    assert io.stderr == b"cp: cannot backup '/dst': Permission denied\n"
    assert io.writes == {}
    assert links == {"/dst~": referent}
    assert files == {"/src": b"new", "/dst": b"old", "/safe": b"safe"}


@pytest.mark.asyncio
async def test_recursive_copy_omits_hidden_links():
    ws = Workspace(
        {
            "/data": (RAMVFS(), MountMode.WRITE),
            "/other": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    await ws.shell(
        "mkdir -p /data/src/sec && echo visible > /data/src/a && "
        "ln -s a /data/src/public && ln -s /private/key /data/src/secret && "
        "ln -s /private/nested /data/src/sec/link"
    )
    ws.create_session(
        "agent",
        profile={"paths": {"hide": ["/data/src/secret", "/data/src/sec"]}},
    )
    result = await ws.shell("cp -rL /data/src /other/copy", session_id="agent")
    assert result.exit_code == 0
    assert await result.materialize_stderr() == b""
    copied = await ws.shell("ls -A /other/copy && cat /other/copy/public")
    assert await copied.materialize_stdout() == b"a\npublic\nvisible\n"
    assert not ws.namespace.is_link("/other/copy/secret")
    assert not ws.namespace.is_link("/other/copy/sec/link")
