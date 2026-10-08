import asyncio
import errno
from collections.abc import Awaitable, Callable
from functools import partial
from operator import attrgetter

import pytest

from mirage.commands.builtin.generic.ls import (
    LS_FAILURE,
    LS_MINOR_PROBLEM,
    LS_OK,
    LsWarning,
    exit_status_for,
    filevercmp,
    ls,
    parse_flags,
    type_indicator,
    walk,
)
from mirage.commands.builtin.utils.formatting import LsColumns
from mirage.errors.types import CommandTimeoutError
from mirage.types import (
    ContentType,
    FileStat,
    FileType,
    LsIndicator,
    LsSortBy,
    LsTimeKind,
    PathSpec,
)
from mirage.view.types import MountView


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path, directory=path, vfs_path=path.strip("/"))


def _make_fs_backend(tree: dict[str, FileStat]):
    """Build (readdir, stat) callables over an in-memory entry tree.

    `tree` maps absolute path → FileStat. Directories are entries whose
    type == FileType.DIRECTORY. readdir lists direct children of the path.
    """

    async def stat(p: PathSpec, index=None) -> FileStat:
        if p.virtual not in tree:
            raise FileNotFoundError(p.virtual)
        return tree[p.virtual]

    async def readdir(p: PathSpec, _index=None) -> list[str]:
        if p.virtual not in tree:
            raise FileNotFoundError(p.virtual)
        if tree[p.virtual].type != FileType.DIRECTORY:
            raise ValueError(f"not a directory: {p.virtual}")
        prefix = p.virtual.rstrip("/") + "/"
        children: list[str] = []
        for key in tree:
            if key == p.virtual:
                continue
            if key.startswith(prefix):
                remainder = key[len(prefix) :]
                if "/" not in remainder:
                    children.append(key)
        return sorted(children)

    return readdir, stat


async def _stat_denying(
    p: PathSpec,
    index=None,
    *,
    stat: Callable[..., Awaitable[FileStat]],
    blocked: str,
) -> FileStat:
    if p.virtual == blocked:
        raise PermissionError(13, "Permission denied")
    return await stat(p, index)


async def _readdir_denying(
    p: PathSpec,
    index=None,
    *,
    readdir: Callable[..., Awaitable[list[str]]],
    blocked: str,
) -> list[str]:
    if p.virtual == blocked:
        raise PermissionError(13, "Permission denied")
    return await readdir(p, index)


def _file(name: str, size: int = 0, modified: str | None = None) -> FileStat:
    return FileStat(
        name=name,
        size=size,
        modified=modified,
        type=FileType.FILE,
        content=ContentType.TEXT,
    )


def _dir(name: str) -> FileStat:
    return FileStat(name=name, size=None, type=FileType.DIRECTORY)


@pytest.mark.asyncio
async def test_walk_stats_one_entry_at_a_time():
    # On a mount that keeps no listing index each entry's stat is a
    # backend request; a whole directory's worth at once is a burst.
    tree = {"/dir": _dir("dir")}
    tree.update({f"/dir/{i}.json": _file(f"{i}.json") for i in range(40)})
    readdir, stat = _make_fs_backend(tree)
    flight = {"now": 0, "peak": 0}

    async def slow_stat(p: PathSpec, index=None) -> FileStat:
        flight["now"] += 1
        flight["peak"] = max(flight["peak"], flight["now"])
        await asyncio.sleep(0.001)
        flight["now"] -= 1
        return await stat(p, index)

    res = await walk(_spec("/dir"), readdir=readdir, stat=slow_stat)
    assert len(res.entries) == 40
    assert flight["peak"] == 1


@pytest.mark.asyncio
async def test_ls_unstattable_entry_is_a_minor_problem():
    """An entry below the operand is not a command-line arg, so GNU keeps
    listing its siblings, keeps the entry's own row of ``?``, and exits 1.
    """
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt"),
        "/dir/locked.txt": _file("locked.txt"),
    }
    readdir, stat = _make_fs_backend(tree)

    denying_stat = partial(_stat_denying, stat=stat, blocked="/dir/locked.txt")
    output, io = await ls(
        [_spec("/dir")], readdir=readdir, stat=denying_stat, long=True
    )
    assert io.exit_code == LS_MINOR_PROBLEM
    assert output.decode().endswith("? locked.txt\n")
    assert b"locked.txt" in (io.stderr or b"")


def _failing_entry(exc: Exception):
    """A readdir/stat pair over /dir whose b.txt fails its stat.

    Args:
        exc (Exception): what b.txt's stat raises.
    """
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt", 1, "2026-01-01T00:00:00Z"),
        "/dir/b.txt": _file("b.txt", 1, "2026-01-01T00:00:00Z"),
    }
    readdir, stat = _make_fs_backend(tree)

    async def failing_stat(p: PathSpec, index=None) -> FileStat:
        if p.virtual == "/dir/b.txt":
            raise exc
        return await stat(p, index)

    return readdir, failing_stat


# GNU (coreutils 9.7, EIO injected on one entry with strace) lists every
# name, and only a listing that stats the entry (-l, -F, -t, -i ...)
# reports it, whatever the errno, and exits 1.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "exc, flags, row, stderr",
    [
        (FileNotFoundError("/dir/b.txt"), {}, "b.txt", b""),
        (RuntimeError("upstream 502 Bad Gateway"), {}, "b.txt", b""),
        (
            FileNotFoundError("/dir/b.txt"),
            {"long": True},
            "?????????? ? ? ? ?            ? b.txt",
            b"ls: cannot access '/dir/b.txt': No such file or directory\n",
        ),
        (
            RuntimeError("S3 GET b.txt failed: 403 Forbidden"),
            {"indicator": LsIndicator.CLASSIFY},
            "b.txt",
            b"ls: cannot access '/dir/b.txt': S3 GET b.txt failed: 403 Forbidden\n",
        ),
        (
            OSError(errno.EIO, "socket hang up"),
            {"long": True},
            "?????????? ? ? ? ?            ? b.txt",
            b"ls: cannot access '/dir/b.txt': Input/output error\n",
        ),
    ],
)
async def test_ls_lists_an_unstattable_entry(exc, flags, row, stderr):
    readdir, stat = _failing_entry(exc)
    output, io = await ls([_spec("/dir")], readdir=readdir, stat=stat, **flags)
    *_, sibling, last = output.decode().splitlines()
    assert sibling.endswith("a.txt") and last == row
    assert (io.stderr or b"") == stderr
    assert io.exit_code == (LS_MINOR_PROBLEM if stderr else LS_OK)


# GNU (coreutils 9.7, both entries' stat denied) zeroes a failed stat, so
# -S sorts the rows as size 0 even where readdir marked a directory.
@pytest.mark.asyncio
async def test_ls_size_sort_counts_an_unstattable_directory_as_zero():
    tree = {
        "/d": _dir("d"),
        "/d/afile": _file("afile", 5000, "2026-01-01T00:00:00Z"),
        "/d/zdir": _dir("zdir"),
    }
    readdir, stat = _make_fs_backend(tree)

    async def marking_readdir(p: PathSpec, index=None) -> list[str]:
        return [
            f"{e}/" if tree[e].type == FileType.DIRECTORY else e
            for e in await readdir(p, index)
        ]

    async def denying_stat(p: PathSpec, index=None) -> FileStat:
        if p.virtual != "/d":
            raise PermissionError(errno.EACCES, "Permission denied")
        return await stat(p, index)

    output, io = await ls(
        [_spec("/d")],
        readdir=marking_readdir,
        stat=denying_stat,
        sort_by=LsSortBy.SIZE,
    )
    assert io.exit_code == LS_MINOR_PROBLEM
    assert output == b"afile\nzdir\n"


@pytest.mark.asyncio
async def test_ls_still_ends_on_a_timeout():
    readdir, stat = _failing_entry(CommandTimeoutError("stat", 5))
    with pytest.raises(CommandTimeoutError):
        await ls([_spec("/dir")], readdir=readdir, stat=stat)


@pytest.mark.asyncio
async def test_ls_still_propagates_the_operands_own_failure():
    _, stat = _failing_entry(RuntimeError("socket hang up"))

    async def readdir(p: PathSpec, _index=None) -> list[str]:
        raise RuntimeError("socket hang up")

    with pytest.raises(RuntimeError, match="socket hang up"):
        await ls([_spec("/dir")], readdir=readdir, stat=stat)


@pytest.mark.asyncio
async def test_ls_serious_problem_outranks_a_minor_one():
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt"),
        "/dir/sub": _dir("sub"),
    }
    readdir, stat = _make_fs_backend(tree)

    denying_readdir = partial(
        _readdir_denying, readdir=readdir, blocked="/dir/sub"
    )
    _, io = await ls(
        [_spec("/dir"), _spec("/nope")],
        readdir=denying_readdir,
        stat=stat,
        recursive=True,
    )
    assert io.exit_code == LS_FAILURE


def test_exit_status_for_ratchets_like_gnu():
    minor = LsWarning("ls: cannot access 'x': Permission denied", False)
    serious = LsWarning("ls: cannot access '/nope': No such file", True)
    assert exit_status_for([]) == LS_OK
    assert exit_status_for([minor]) == LS_MINOR_PROBLEM
    assert exit_status_for([serious]) == LS_FAILURE
    assert exit_status_for([minor, serious]) == LS_FAILURE
    assert exit_status_for([serious, minor]) == LS_FAILURE


def _mount_view(*roots: str) -> MountView:
    """A mount table holding exactly ``roots``.

    Only ``is_root`` is exercised: it is what tells a nested mount's root
    (whose listing belongs to another backend) from a directory the
    namespace merely owes children, which -R must still descend.
    """
    return MountView(
        descendants=lambda p: [
            r for r in roots if r.startswith(p.rstrip("/") + "/")
        ],
        visible_descendants=lambda p: [
            r for r in roots if r.startswith(p.rstrip("/") + "/")
        ],
        is_root=lambda p: p.rstrip("/") in roots,
        root_of=lambda p: "/",
    )


@pytest.mark.asyncio
async def test_structure_only_chain_descends_under_recursive():
    """A structure chain (a link's ancestors) continues below the first
    level, so -R descends it: only a mount root stops the walk."""

    async def readdir(p, index=None):
        raise FileNotFoundError(p.virtual)

    async def stat(p, index=None):
        raise FileNotFoundError(p.virtual)

    def child_mounts(parent: str) -> list[str]:
        if parent == "/ghost":
            return ["deep"]
        if parent == "/ghost/deep":
            return ["lnk"]
        return []

    out, io = await ls(
        [PathSpec.from_str_path("/ghost")],
        readdir=readdir,
        stat=stat,
        recursive=True,
        child_mounts=child_mounts,
        mounts=_mount_view("/ghost/deep/lnk"),
    )
    assert io.exit_code == 0
    assert out.decode() == "/ghost:\ndeep\n\n/ghost/deep:\nlnk\n"


@pytest.mark.asyncio
async def test_a_child_mount_row_falls_back_to_directory_with_no_dispatcher():
    """Absence of the door can only mean "nobody can answer", so the row
    keeps the shape every caller outside a workspace already saw."""
    tree = {"/base": _dir("base")}
    readdir, stat = _make_fs_backend(tree)
    out, io = await ls(
        [PathSpec.from_str_path("/base")],
        readdir=readdir,
        stat=stat,
        indicator=LsIndicator.CLASSIFY,
        child_mounts=lambda d: ["hist"] if d == "/base" else [],
    )
    assert io.exit_code == 0
    assert out.decode() == "hist/\n"


# ── the flag set beyond -l: sort orders, columns, time styles ──────────


def test_filevercmp_pins_gnu_corner_cases():
    assert filevercmp("file2.txt", "file10.txt") < 0
    assert filevercmp("a.txt", "a.tar.gz") > 0
    assert filevercmp("", "a") < 0
    assert filevercmp(".", "..") < 0
    assert filevercmp(".hidden", "a") < 0
    assert filevercmp("1.0~rc1", "1.0") < 0
    assert filevercmp("abc", "abc") == 0


def test_filevercmp_orders_bytes_past_the_letters():
    # Pinned on coreutils 9.7 under LC_ALL=C: `_ { é ÿ Ā €` and
    # `a- a{ aé`, since gnulib classifies bytes, not code points.
    assert filevercmp("_", "{") < 0
    assert filevercmp("{", "é") < 0
    assert filevercmp("é", "ÿ") < 0
    assert filevercmp("ÿ", "Ā") < 0
    assert filevercmp("Ā", "€") < 0
    assert filevercmp("a-", "a{") < 0
    assert filevercmp("a{", "aé") < 0
    assert filevercmp("\uffff", "\U0001d11e") < 0


@pytest.mark.asyncio
async def test_access_time_sorts_and_shows_under_u():
    tree = {
        "/t": _dir("t"),
        "/t/old.txt": FileStat(
            name="old.txt",
            size=1,
            modified="2025-01-01T00:00:00Z",
            atime="2025-06-01T00:00:00Z",
            type=FileType.FILE,
        ),
        "/t/new.txt": FileStat(
            name="new.txt",
            size=1,
            modified="2025-03-01T00:00:00Z",
            atime="2025-02-01T00:00:00Z",
            type=FileType.FILE,
        ),
    }
    readdir, stat = _make_fs_backend(tree)
    output, _ = await ls(
        [_spec("/t")],
        readdir=readdir,
        stat=stat,
        sort_by=LsSortBy.TIME,
        time_kind=LsTimeKind.ATIME,
    )
    assert output.decode().split() == ["old.txt", "new.txt"]
    output, _ = await ls(
        [_spec("/t")],
        readdir=readdir,
        stat=stat,
        long=True,
        columns=LsColumns(
            owner=False,
            group=False,
            time_kind=LsTimeKind.ATIME,
            time_style="long-iso",
        ),
    )
    assert output.decode().splitlines() == [
        "total ?",
        "-rw-r--r-- 1 1 2025-02-01 00:00 new.txt",
        "-rw-r--r-- 1 1 2025-06-01 00:00 old.txt",
    ]


@pytest.mark.parametrize(
    "flags,sort_by,time_kind",
    [
        ({"t": True, "S": True}, LsSortBy.SIZE, LsTimeKind.MTIME),
        ({"S": True, "sort": "version"}, LsSortBy.VERSION, LsTimeKind.MTIME),
        ({"u": True}, LsSortBy.TIME, LsTimeKind.ATIME),
        ({"u": True, "args_l": True}, LsSortBy.NAME, LsTimeKind.ATIME),
        (
            {"c": True, "u": True, "time": "status"},
            LsSortBy.TIME,
            LsTimeKind.CTIME,
        ),
        ({"X": True, "U": True}, LsSortBy.NONE, LsTimeKind.MTIME),
    ],
)
def test_parse_flags_last_sort_and_time_spelling_win(
    flags, sort_by, time_kind
):
    parsed = parse_flags(flags)
    assert parsed.sort_by is sort_by
    assert parsed.time_kind is time_kind


# gnulib's argmatch resolves an unambiguous prefix and answers the
# canonical word of the value it matched. Every row measured on coreutils
# 9.7 (`ls --sort=non`, `-l --time=acc`, `--hyperlink=n`,
# `-l --time-style=full`).
@pytest.mark.parametrize(
    "flags,attr,expected",
    [
        ({"sort": "non"}, "sort_by", LsSortBy.NONE),
        ({"sort": "si"}, "sort_by", LsSortBy.SIZE),
        ({"time": "a"}, "time_kind", LsTimeKind.ATIME),
        ({"time": "acc"}, "time_kind", LsTimeKind.ATIME),
        ({"time": "u"}, "time_kind", LsTimeKind.ATIME),
        ({"time": "m"}, "time_kind", LsTimeKind.MTIME),
        ({"time": "s"}, "time_kind", LsTimeKind.CTIME),
        ({"time": "b"}, "time_kind", LsTimeKind.BIRTH),
        ({"hyperlink": "al"}, "hyperlink", True),
        ({"hyperlink": "y"}, "hyperlink", True),
        ({"hyperlink": "f"}, "hyperlink", True),
        ({"hyperlink": "n"}, "hyperlink", False),
        ({"hyperlink": "au"}, "hyperlink", False),
        ({"hyperlink": "i"}, "hyperlink", False),
        ({"time_style": "full"}, "columns.time_style", "full-iso"),
        ({"time_style": "long"}, "columns.time_style", "long-iso"),
        ({"time_style": "i"}, "columns.time_style", "iso"),
        ({"time_style": "loc"}, "columns.time_style", "locale"),
        ({"time_style": "posix-full"}, "columns.time_style", "locale"),
    ],
)
def test_parse_flags_accepts_an_unambiguous_prefix(flags, attr, expected):
    assert attrgetter(attr)(parse_flags(flags)) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["", "/data", "/nested/data"])
@pytest.mark.parametrize("subdir", [False, True])
@pytest.mark.parametrize("namespace", [False, True])
async def test_dot_entries_respect_mount_boundary(prefix, subdir, namespace):
    root = prefix or "/"
    directory = f"{prefix}/sub" if subdir else root
    tree = {
        root: FileStat(name="root", type=FileType.DIRECTORY, mode=0o751),
        f"{prefix}/sub": FileStat(
            name="sub", type=FileType.DIRECTORY, mode=0o750
        ),
    }
    readdir, backend_stat = _make_fs_backend(tree)
    calls = []
    namespace_calls = []

    async def stat(path, index=None):
        calls.append((path.virtual, path.vfs_path))
        assert path.virtual in tree
        assert path.vfs_path == path.virtual[len(prefix) :].strip("/")
        return await backend_stat(path, index)

    async def stat_path(path):
        namespace_calls.append(path)
        return tree.get(
            path, FileStat(name="parent", type=FileType.DIRECTORY, mode=0o700)
        )

    output, io = await ls(
        [
            PathSpec(
                virtual=directory,
                directory=directory,
                vfs_path="sub" if subdir else "",
            )
        ],
        readdir=readdir,
        stat=stat,
        long=True,
        all_files=True,
        show_dot_entries=True,
        stat_path=stat_path if namespace else None,
    )
    assert io.exit_code == 0
    assert not io.stderr
    dot_mode = "drwxr-x---" if subdir else "drwxr-x--x"
    parent_mode = (
        "drwxr-x--x"
        if subdir or not prefix
        else "drwx------"
        if namespace
        else "drwxr-xr-x"
    )
    assert f"{dot_mode} 1 - - 4096 - .\n" in output.decode()
    assert f"{parent_mode} 1 - - 4096 - ..\n" in output.decode()
    if namespace:
        parent = (
            prefix if subdir and prefix else (root.rsplit("/", 1)[0] or "/")
        )
        assert namespace_calls[-2:] == [directory, parent]
    else:
        assert calls


@pytest.mark.parametrize(
    "kind,mode,marks",
    [
        (FileType.DIRECTORY, None, ("", "/", "/", "/")),
        (FileType.SYMLINK, None, ("", "", "@", "@")),
        (FileType.FIFO, None, ("", "", "|", "|")),
        (FileType.FILE, 0o755, ("", "", "", "*")),
        (FileType.FILE, 0o644, ("", "", "", "")),
    ],
)
def test_type_indicator_marks_by_style(kind, mode, marks):
    # ls.c get_type_indicator: slash marks only directories, and only
    # classify marks an executable.
    entry = FileStat(name="x", type=kind, mode=mode)
    styles = (
        LsIndicator.NONE,
        LsIndicator.SLASH,
        LsIndicator.FILE_TYPE,
        LsIndicator.CLASSIFY,
    )
    assert tuple(type_indicator(entry, s) for s in styles) == marks


def test_type_indicator_marks_nothing_it_could_not_stat():
    assert type_indicator(None, LsIndicator.CLASSIFY) == ""
