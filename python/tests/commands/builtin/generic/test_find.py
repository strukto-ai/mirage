from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.generic.find import (
    apply_mount_prefix,
    apply_mtime_filter,
    parse_find_args,
)
from mirage.commands.builtin.generic.find import find as stream_find
from mirage.commands.builtin.generic.find import (
    find_walk_generic as stream_walk_find,
)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import FindParseError
from mirage.core.generic.find import walk_find
from mirage.core.generic.find_eval import FindArgs, Name, Not, Or
from mirage.errors.types import CommandTimeoutError
from mirage.io.types import materialize
from mirage.types import (
    ContentType,
    FileStat,
    FileType,
    FindType,
    PathSpec,
)
from mirage.view.types import LinkView


async def find(*args, **kwargs):
    out, io = await stream_find(*args, **kwargs)
    return await materialize(out), io


async def find_walk_generic(*args, **kwargs):
    out, io = await stream_walk_find(*args, **kwargs)
    return await materialize(out), io


def _defaults() -> dict:
    return asdict(FindArgs())


def test_parse_find_args_empty_returns_defaults():
    args = parse_find_args(())
    assert asdict(args) == _defaults()


@pytest.mark.parametrize(
    "kwargs,expected,filled",
    [
        ({"name": "*.txt"}, {"name": "*.txt", "or_names": None}, ()),
        (
            {"iname": "HELLO.*", "path": "**/sub/*"},
            {"iname": "HELLO.*", "path_pattern": "**/sub/*"},
            (),
        ),
        (
            {"maxdepth": "3", "mindepth": "1"},
            {"maxdepth": 3, "mindepth": 1},
            (),
        ),
        ({"size": "+500c"}, {"min_size": 501, "max_size": None}, ()),
        ({"size": "-1k"}, {"min_size": None, "max_size": 0}, ()),
        ({"size": "1k"}, {"min_size": 1, "max_size": 1024}, ()),
        ({"mtime": "-1"}, {"mtime_max": None}, ("mtime_min",)),
        ({"mtime": "+7"}, {"mtime_min": None}, ("mtime_max",)),
        ({"type": "d"}, {"type": FindType.DIRECTORY}, ()),
        ({"type": "f"}, {"type": FindType.FILE}, ()),
        ({"type": "symlink"}, {"type": "symlink"}, ()),
    ],
)
def test_parse_find_args_reads_each_flag(kwargs, expected, filled):
    args = parse_find_args((), **kwargs)
    got = {field: getattr(args, field) for field in expected}
    assert got == expected
    assert [type(v) for v in got.values()] == [
        type(v) for v in expected.values()
    ]
    assert all(getattr(args, field) is not None for field in filled)


def test_parse_find_args_unknown_predicate_raises():
    with pytest.raises(
        FindParseError, match="find: unknown predicate '-bogus'"
    ):
        parse_find_args(("-bogus",))


def test_parse_find_args_negation_builds_not_tree():
    args = parse_find_args(("-not", "-name", "*.pyc"))
    assert args.tree == Not(Name("*.pyc"))


def test_parse_find_args_or_builds_or_tree():
    args = parse_find_args(("-name", "*.txt", "-o", "-name", "*.py"))
    assert args.tree == Or([Name("*.txt"), Name("*.py")])


@pytest.mark.asyncio
async def test_apply_mtime_filter_skips_when_no_window():
    out = await apply_mtime_filter(
        ["/a.txt"],
        mtime_min=None,
        mtime_max=None,
        stat=_unreached_stat,
    )
    assert out == ["/a.txt"]


@pytest.mark.asyncio
async def test_apply_mtime_filter_stats_the_mounted_virtual_path():
    now = datetime.now(tz=timezone.utc)
    stat = AsyncMock(
        return_value=FileStat(
            name="a.txt",
            size=1,
            modified=now.isoformat(),
            type=FileType.FILE,
            content=ContentType.TEXT,
        )
    )

    out = await apply_mtime_filter(
        ["/a.txt"],
        mtime_min=now.timestamp() - 60,
        mtime_max=now.timestamp() + 60,
        stat=stat,
        mount_prefix="/mnt",
    )

    assert out == ["/a.txt"]
    spec = stat.await_args.args[0]
    assert spec.virtual == "/mnt/a.txt"
    assert spec.vfs_path == "a.txt"


_NOON = datetime(2025, 6, 1, 12, 0, tzinfo=timezone.utc)
_NOON_PLUS_9 = datetime(2025, 6, 1, 12, 0, tzinfo=timezone(timedelta(hours=9)))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "modified,mtime_min,mtime_max,expected",
    [
        pytest.param(
            _NOON.isoformat(),
            _NOON.timestamp() - 60,
            _NOON.timestamp() + 60,
            ["/a.txt"],
            id="inside",
        ),
        pytest.param(
            datetime(2020, 1, 1, tzinfo=timezone.utc).isoformat(),
            datetime(2025, 1, 1, tzinfo=timezone.utc).timestamp(),
            None,
            [],
            id="outside",
        ),
        pytest.param(None, 1.0, None, [], id="no-modified-time"),
        pytest.param(
            _NOON_PLUS_9.isoformat(),
            _NOON_PLUS_9.timestamp() - 60,
            _NOON_PLUS_9.timestamp() + 60,
            ["/a.txt"],
            id="reported-utc-offset",
        ),
        pytest.param("not-a-date", 1.0, None, [], id="malformed"),
    ],
)
async def test_apply_mtime_filter_windows(
    modified, mtime_min, mtime_max, expected
):
    async def stat(_spec: PathSpec) -> FileStat:
        return FileStat(
            name="a.txt",
            size=1,
            modified=modified,
            type=FileType.FILE,
            content=ContentType.TEXT,
        )

    out = await apply_mtime_filter(
        ["/a.txt"], mtime_min=mtime_min, mtime_max=mtime_max, stat=stat
    )
    assert out == expected


@pytest.mark.asyncio
async def test_apply_mtime_filter_silently_skips_stat_errors():
    async def stat(_spec: PathSpec) -> FileStat:
        raise FileNotFoundError("gone")

    out = await apply_mtime_filter(
        ["/a.txt", "/b.txt"],
        mtime_min=1.0,
        mtime_max=None,
        stat=stat,
    )
    assert out == []


@pytest.mark.parametrize(
    "entries,prefix,expected",
    [
        (["/a.txt"], "", ["/a.txt"]),
        (["/a.txt", "/dir/b.txt"], "/mnt", ["/mnt/a.txt", "/mnt/dir/b.txt"]),
        (["a.txt"], "/mnt", ["/mnt/a.txt"]),
    ],
)
def test_apply_mount_prefix(entries, prefix, expected):
    assert apply_mount_prefix(entries, prefix) == expected


async def _unreached_stat(_spec: PathSpec) -> FileStat:
    raise AssertionError("stat should not be called when no mtime window set")


def _root_spec() -> PathSpec:
    return PathSpec(vfs_path="", virtual="/", directory="/", resolved=False)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "readdir,args,expected",
    [
        pytest.param(
            AsyncMock(side_effect=FileNotFoundError("/")),
            FindArgs(),
            [],
            id="readdir",
        ),
        pytest.param(
            AsyncMock(return_value=["/mystery"]),
            FindArgs(type=FindType.FILE),
            ["/mystery"],
            id="type-stat-falls-back-to-file",
        ),
        pytest.param(
            AsyncMock(return_value=["/a.json"]),
            FindArgs(min_size=1),
            [],
            id="size-stat-drops-the-entry",
        ),
    ],
)
async def test_walk_find_tolerates_not_found(readdir, args, expected):
    stat = AsyncMock(side_effect=FileNotFoundError("gone"))
    results = await walk_find(
        _root_spec(), readdir=readdir, stat=stat, index=None, args=args
    )
    assert results == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "readdir,stat,args,match",
    [
        pytest.param(
            AsyncMock(side_effect=ValueError("bad page token")),
            AsyncMock(
                return_value=FileStat(name="/", type=FileType.DIRECTORY)
            ),
            FindArgs(),
            "bad page token",
            id="readdir",
        ),
        pytest.param(
            AsyncMock(return_value=["/mystery"]),
            AsyncMock(side_effect=ValueError("rate limited")),
            FindArgs(),
            "rate limited",
            id="stat",
        ),
        pytest.param(
            AsyncMock(return_value=["/a.json"]),
            AsyncMock(side_effect=ValueError("rate limited")),
            FindArgs(min_size=1),
            "rate limited",
            id="size-stat",
        ),
    ],
)
async def test_walk_find_propagates_any_other_error(
    readdir, stat, args, match
):
    with pytest.raises(ValueError, match=match):
        await walk_find(
            _root_spec(), readdir=readdir, stat=stat, index=None, args=args
        )


@pytest.mark.asyncio
async def test_walk_find_emits_start_path_at_depth_zero():
    readdir = AsyncMock(return_value=["/child.txt"])
    stat = AsyncMock(return_value=FileStat(name="/", type=FileType.DIRECTORY))
    results = await walk_find(
        _root_spec(),
        readdir=readdir,
        stat=stat,
        index=None,
        args=FindArgs(maxdepth=0),
    )
    assert results == ["/"]
    readdir.assert_not_awaited()


def _flaky(exc: Exception, calls: list[str] | None = None):
    """A readdir/stat pair whose one entry fails its stat like a dropped
    request, every other entry answering.

    Args:
        exc (Exception): what the failing entry's stat raises.
        calls (list[str] | None): records every path statted.
    """
    stats = {
        "/": FileStat(name="/", type=FileType.DIRECTORY),
        **{
            f"/{n}.json": FileStat(
                name=f"{n}.json", size=1, type=FileType.FILE
            )
            for n in "abc"
        },
    }

    async def readdir(spec: PathSpec, _index):
        return ["/a.json", "/b.json", "/c.json"]

    async def stat(spec: PathSpec, _index):
        if calls is not None:
            calls.append(spec.virtual)
        if spec.virtual == "/b.json":
            raise exc
        return stats[spec.virtual]

    return readdir, stat


@pytest.mark.asyncio
async def test_walk_find_records_an_entry_whose_stat_fails_and_walks_on():
    exc = RuntimeError("upstream 502 Bad Gateway")
    readdir, stat = _flaky(exc)
    unstatted: dict[str, Exception] = {}
    results = await walk_find(
        _root_spec(),
        readdir=readdir,
        stat=stat,
        index=None,
        args=FindArgs(type=FindType.FILE),
        unstatted=unstatted,
    )
    assert results == ["/a.json", "/b.json", "/c.json"]
    assert unstatted == {"/b.json": exc}


@pytest.mark.asyncio
async def test_walk_find_fails_a_stat_test_without_asking_again():
    calls: list[str] = []
    readdir, stat = _flaky(RuntimeError("upstream 502 Bad Gateway"), calls)
    results = await walk_find(
        _root_spec(),
        readdir=readdir,
        stat=stat,
        index=None,
        args=FindArgs(min_size=1),
        unstatted={},
    )
    assert results == ["/", "/a.json", "/c.json"]
    assert calls.count("/b.json") == 1


@pytest.mark.asyncio
async def test_walk_find_propagates_an_entry_failure_it_does_not_collect():
    readdir, stat = _flaky(RuntimeError("upstream 502 Bad Gateway"))
    with pytest.raises(RuntimeError, match="502"):
        await walk_find(
            _root_spec(),
            readdir=readdir,
            stat=stat,
            index=None,
            args=FindArgs(),
        )


@pytest.mark.asyncio
async def test_walk_find_propagates_a_timeout_even_when_collecting():
    readdir, stat = _flaky(CommandTimeoutError("stat", 5))
    with pytest.raises(CommandTimeoutError):
        await walk_find(
            _root_spec(),
            readdir=readdir,
            stat=stat,
            index=None,
            args=FindArgs(),
            unstatted={},
        )


@pytest.mark.asyncio
async def test_walk_find_empty_matches_empty_files_and_dirs():
    async def readdir(spec: PathSpec, _index):
        table = {
            "/": ["/empty.txt", "/full.txt", "/empty-dir", "/full-dir"],
            "/empty-dir": [],
            "/full-dir": ["/full-dir/a.txt"],
        }
        return table[spec.virtual]

    async def stat(spec: PathSpec, _index):
        stats = {
            "/": FileStat(name="/", type=FileType.DIRECTORY),
            "/empty.txt": FileStat(
                name="empty.txt",
                size=0,
                type=FileType.FILE,
                content=ContentType.TEXT,
            ),
            "/full.txt": FileStat(
                name="full.txt",
                size=1,
                type=FileType.FILE,
                content=ContentType.TEXT,
            ),
            "/empty-dir": FileStat(name="empty-dir", type=FileType.DIRECTORY),
            "/full-dir": FileStat(name="full-dir", type=FileType.DIRECTORY),
            "/full-dir/a.txt": FileStat(
                name="a.txt",
                size=1,
                type=FileType.FILE,
                content=ContentType.TEXT,
            ),
        }
        return stats[spec.virtual]

    results = await walk_find(
        _root_spec(),
        readdir=readdir,
        stat=stat,
        index=None,
        args=parse_find_args(("-empty",)),
    )
    assert results == ["/empty-dir", "/empty.txt"]


@pytest.mark.asyncio
async def test_walk_find_time_test_before_prune_gates_it():
    now = "2026-01-01T00:00:00Z"

    async def readdir(spec: PathSpec, _index):
        table = {
            "/": ["/old", "/new"],
            "/old": ["/old/f.txt"],
            "/new": ["/new/g.txt"],
        }
        return table[spec.virtual]

    async def stat(spec: PathSpec, _index):
        stamps = {
            "/": now,
            "/old": "2000-01-01T00:00:00Z",
            "/new": now,
            "/old/f.txt": now,
            "/new/g.txt": now,
        }
        name = spec.virtual.rsplit("/", 1)[-1] or "/"
        kind = FileType.FILE if "." in name else FileType.DIRECTORY
        return FileStat(name=name, type=kind, modified=stamps[spec.virtual])

    gated = parse_find_args(
        ("-mindepth", "1", "-newermt", "2010-01-01", "-prune")
    )
    assert await walk_find(
        _root_spec(), readdir=readdir, stat=stat, index=None, args=gated
    ) == ["/new", "/old/f.txt"]
    firm = parse_find_args(
        ("-mindepth", "1", "-prune", "-newermt", "2010-01-01")
    )
    assert await walk_find(
        _root_spec(), readdir=readdir, stat=stat, index=None, args=firm
    ) == ["/new"]


@pytest.mark.parametrize(
    "kwargs,message",
    [
        ({"maxdepth": "abc"}, "find: invalid argument 'abc' to '-maxdepth'"),
        ({"mindepth": "xx"}, "find: invalid argument 'xx' to '-mindepth'"),
        ({"size": ""}, "find: invalid null argument to -size"),
        ({"size": "abc"}, "find: Invalid argument `abc' to -size"),
        ({"size": "5x"}, "find: invalid -size type `x'"),
        ({"mtime": "abc"}, "find: invalid argument 'abc' to '-mtime'"),
    ],
)
def test_parse_find_args_invalid_numeric_raises_find_parse_error(
    kwargs, message
):
    with pytest.raises(FindParseError) as exc:
        parse_find_args((), **kwargs)
    assert str(exc.value) == message


# ── Issue #312 parse-level regression tests ────────────────


def test_parse_find_args_maxdepth_zero():
    args = parse_find_args(("-maxdepth", "0"))
    assert args.maxdepth == 0


def test_parse_find_args_empty_predicate():
    args = parse_find_args(("-empty",))
    assert args.empty is True


def _file_spec(virtual: str = "/mnt/a.txt", key: str = "a.txt") -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual[: virtual.rfind("/") + 1],
        vfs_path=key,
    )


def _stat_path(stat: FileStat | None):
    async def fn(_virtual: str) -> FileStat | None:
        return stat

    return fn


async def _unreached_core(*_a, **_kw) -> list[str]:
    raise AssertionError("find_core must not be called for a file start point")


# GNU findutils 4.10.0, pinned on debian:stable-slim:
#   find <file>             -> <file>   find <file> -type d -> (empty)
#   find <file> -type f     -> <file>   find <file> -type l -> (empty)
#   find <file> -maxdepth 0 -> <file>   find <file> -mindepth 1 -> (empty)
#   find <missing>          -> exit 1, and the GNU diagnostic below


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "texts,flags,expected",
    [
        ((), {}, b"/mnt/a.txt\n"),
        (("-type", "f"), {}, b"/mnt/a.txt\n"),
        (("-type", "d"), {}, b""),
        (("-type", "l"), {}, b""),
        ((), {"maxdepth": "0"}, b"/mnt/a.txt\n"),
        ((), {"mindepth": "1"}, b""),
        ((), {"size": "+1c"}, b"/mnt/a.txt\n"),
        ((), {"size": "+99c"}, b""),
        ((), {"name": "a.txt"}, b"/mnt/a.txt\n"),
        ((), {"name": "nope"}, b""),
        ((), {"type": "f"}, b"/mnt/a.txt\n"),
        ((), {"type": "d"}, b""),
        ((), {"type": "l"}, b""),
    ],
)
async def test_find_file_start_point_is_tested_not_walked(
    texts, flags, expected
):
    """A start point that is not a directory never reaches the backend.

    Every backend answered a walk of one differently: an object store
    listed the key as a prefix and returned nothing, Graph 404'd on the
    children of a file, and Box raised ENOTDIR. The flag form passes the
    value through, so `-type l` (a namespace symlink, which no backend
    entry ever is) filters instead of reading as "no filter".
    """
    stdout, io = await find(
        [_file_spec()],
        texts,
        find_core=_unreached_core,
        stat_path=_stat_path(
            FileStat(
                name="a.txt",
                size=6,
                type=FileType.FILE,
                content=ContentType.TEXT,
            )
        ),
        **flags,
    )
    assert io.exit_code == 0
    assert stdout == expected


@pytest.mark.asyncio
async def test_find_file_start_point_respells_the_operand():
    """The row is printed as the operand was typed.

    That is what makes `find -L <link>` name the link rather than the
    target the router resolved it to.
    """
    spec = PathSpec(
        virtual="/mnt/a.txt",
        directory="/mnt/",
        vfs_path="a.txt",
        raw_path="/other/link.txt",
    )
    stdout, _ = await find(
        [spec],
        (),
        find_core=_unreached_core,
        stat_path=_stat_path(
            FileStat(
                name="a.txt",
                size=6,
                type=FileType.FILE,
                content=ContentType.TEXT,
            )
        ),
    )
    assert stdout == b"/other/link.txt\n"


@pytest.mark.asyncio
async def test_find_implicit_directory_start_point_is_walked():
    """A directory that exists only as its children is still walked.

    On a prefix store a directory is not an object, so the probe answers
    for it through readdir instead (``resolve_path_stat``). Reporting it
    as a non-directory row would make `find <dir>` print the directory
    and nothing under it on every such backend.
    """

    async def core(*_a, **_kw) -> list[str]:
        return ["/logs/child.txt"]

    stdout, io = await find(
        [_file_spec(virtual="/mnt/logs", key="logs")],
        (),
        find_core=core,
        stat_path=_stat_path(FileStat(name="logs", type=FileType.DIRECTORY)),
    )
    assert io.exit_code == 0
    # GNU lists the start point before descending, and this core reports
    # descendants only, so the row comes from the generic.
    assert stdout == b"/mnt/logs\n/mnt/logs/child.txt\n"


@pytest.mark.asyncio
async def test_find_missing_start_point_is_gnu_error():
    """GNU names a start point that is not there and exits 1.

    The probe answers on both channels a backend can offer, so None means
    nothing is there rather than "this backend's stat could not see it".
    That is what makes the diagnostic uniform instead of arriving only on
    the backends that wire a stat into find.
    """
    stdout, io = await find(
        [_file_spec(virtual="/mnt/nope", key="nope")],
        (),
        find_core=_unreached_core,
        stat_path=_stat_path(None),
    )
    assert io.exit_code == 1
    assert stdout == b""
    assert io.stderr == b"find: '/mnt/nope': No such file or directory\n"


@pytest.mark.asyncio
async def test_find_missing_start_point_falls_back_to_backend_stat():
    """Without a dispatcher probe, the backend's own stat still answers.

    A command run outside a workspace has no ``stat_path``; the fallback
    guard keeps GNU's diagnostic rather than silently exiting 0.
    """

    async def stat(_spec: PathSpec) -> FileStat:
        raise FileNotFoundError("/mnt/nope")

    stdout, io = await find(
        [_file_spec(virtual="/mnt/nope", key="nope")],
        (),
        find_core=_unreached_core,
        stat=stat,
    )
    assert io.exit_code == 1
    assert stdout == b""
    assert io.stderr == b"find: '/mnt/nope': No such file or directory\n"


@pytest.mark.asyncio
async def test_find_directory_start_point_still_walks():
    async def core(*_a, **_kw) -> list[str]:
        return ["/", "/a.txt"]

    stdout, io = await find(
        [PathSpec(virtual="/mnt", directory="/", vfs_path="", resolved=False)],
        (),
        find_core=core,
        stat_path=_stat_path(FileStat(name="mnt", type=FileType.DIRECTORY)),
    )
    assert io.exit_code == 0
    assert stdout == b"/mnt\n/mnt/a.txt\n"


async def _dir_is_empty(_spec: PathSpec) -> bool:
    return True


async def _dir_has_entries(_spec: PathSpec) -> bool:
    return False


async def _link_exists(_virtual: str) -> bool:
    return True


async def _link_target_stat(_virtual: str) -> FileStat | None:
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "rows,texts,kwargs,expected",
    [
        pytest.param([], (), {}, b"/mnt\n", id="reported"),
        pytest.param(
            [],
            (),
            {"dir_empty": _dir_is_empty, "empty": True},
            b"/mnt\n",
            id="matches-empty",
        ),
        pytest.param(
            [],
            (),
            {"dir_empty": _dir_has_entries, "empty": True},
            b"",
            id="populated-fails-empty",
        ),
        pytest.param(
            ["/"],
            (),
            {"empty": True},
            b"/mnt\n",
            id="no-probe-keeps-the-backend-row",
        ),
        pytest.param(
            ["/"],
            ("-not", "-empty"),
            {"dir_empty": _dir_is_empty},
            b"",
            id="probe-replaces-the-backend-row",
        ),
    ],
)
async def test_find_directory_start_point_emptiness(
    rows, texts, kwargs, expected
):
    """GNU names a directory start point that holds nothing.

    A prefix store answers an empty directory with an empty listing, so
    the start point's row and its ``-empty`` answer come from the generic.
    Without an emptiness probe the backend's own row stands; with one, the
    backend's row is dropped, not merged (ssh reports every directory as
    non-empty).
    """

    async def core(*_a, **_kw) -> list[str]:
        return rows

    stdout, io = await find(
        [PathSpec(virtual="/mnt", directory="/", vfs_path="")],
        texts,
        find_core=core,
        stat_path=_stat_path(FileStat(name="mnt", type=FileType.DIRECTORY)),
        **kwargs,
    )
    assert io.exit_code == 0
    assert stdout == expected


@pytest.mark.asyncio
async def test_find_directory_holding_only_a_link_is_not_empty():
    """A namespace symlink is an entry, so ``-empty`` must skip its parent.

    No backend readdir can see a link, so the emptiness probe alone says
    the directory holds nothing (``has_link_children`` is what corrects
    it). GNU counts the link and prints nothing here.
    """

    async def core(*_a, **_kw) -> list[str]:
        return []

    links = LinkView(
        stat_at=lambda _p: None,
        children=lambda _p: [FileStat(name="lk", type=FileType.SYMLINK)],
        subtree=lambda _p: [],
        resolve=lambda p: p,
        exists=_link_exists,
        target_stat=_link_target_stat,
    )
    stdout, io = await find(
        [PathSpec(virtual="/mnt", directory="/", vfs_path="")],
        (),
        find_core=core,
        stat_path=_stat_path(FileStat(name="mnt", type=FileType.DIRECTORY)),
        dir_empty=_dir_is_empty,
        empty=True,
        links=links,
    )
    assert io.exit_code == 0
    assert stdout == b""


@pytest.mark.asyncio
async def test_find_without_stat_path_walks_as_before():
    """No fact wired (a command constructed outside a workspace) keeps
    the old path, so the walk still decides."""

    async def core(*_a, **_kw) -> list[str]:
        return ["/a.txt"]

    stdout, io = await find([_file_spec()], (), find_core=core)
    assert io.exit_code == 0
    assert stdout == b"/mnt/a.txt\n"


def _stat_map(stats: dict[str, FileStat | None]):
    async def fn(path: str | PathSpec) -> FileStat | None:
        return stats.get(path.virtual if isinstance(path, PathSpec) else path)

    return fn


_DIR_STAT = FileStat(name="d", type=FileType.DIRECTORY)
_FILE_STAT = FileStat(
    name="f", size=6, type=FileType.FILE, content=ContentType.TEXT
)

# GNU findutils 4.10.0, pinned on debian:stable-slim:
#   find A B           -> A's rows, then B's rows (operand order, never
#                         re-sorted across operands)


@pytest.mark.asyncio
async def test_find_walks_every_start_point_in_operand_order():
    calls: list[str] = []

    async def core(path: PathSpec, **_kw) -> list[str]:
        calls.append(path.virtual)
        return ["/sub/z.txt"] if path.virtual == "/mnt/sub" else []

    stdout, io = await find(
        [
            _file_spec(virtual="/mnt/sub", key="sub"),
            _file_spec(virtual="/mnt/a.txt", key="a.txt"),
        ],
        (),
        find_core=core,
        stat_path=_stat_map({"/mnt/sub": _DIR_STAT, "/mnt/a.txt": _FILE_STAT}),
    )
    assert io.exit_code == 0
    # /mnt/a.txt sorts before /mnt/sub; operand order must win anyway.
    assert stdout == b"/mnt/sub\n/mnt/sub/z.txt\n/mnt/a.txt\n"
    # The file start point is reported, never walked.
    assert calls == ["/mnt/sub"]


@pytest.mark.asyncio
@pytest.mark.parametrize("door", ["native", "walk"])
async def test_find_stats_each_start_point_once(door):
    """Streaming a start point's own row early must not stat it again.

    Each stat of a start point is a HEAD and a probe listing on an
    object store, so a second one doubles what find costs before its walk.
    """
    asked: list[str] = []
    stats = _stat_map({"/mnt/sub": _DIR_STAT, "/mnt/a.txt": _FILE_STAT})

    async def stat_path(path: str | PathSpec) -> FileStat | None:
        asked.append(path.virtual if isinstance(path, PathSpec) else path)
        return await stats(path)

    backend: list[str] = []

    async def backend_stat(path: PathSpec, index=None) -> FileStat:
        backend.append(path.virtual)
        found = await stats(path)
        if found is None:
            raise FileNotFoundError(path.virtual)
        return found

    specs = [
        _file_spec(virtual="/mnt/sub", key="sub"),
        _file_spec(virtual="/mnt/a.txt", key="a.txt"),
        _file_spec(virtual="/mnt/gone", key="gone"),
    ]
    if door == "native":
        _, io = await find(
            specs,
            (),
            find_core=AsyncMock(return_value=[]),
            stat_path=stat_path,
        )
    else:
        _, io = await find_walk_generic(
            specs,
            (),
            CommandOpts(stat_path=stat_path),
            readdir=AsyncMock(return_value=[]),
            stat=backend_stat,
        )
    assert io.exit_code == 1
    assert asked == ["/mnt/sub", "/mnt/a.txt", "/mnt/gone"]
    assert backend == ([] if door == "native" else ["/mnt/sub", "/mnt/gone"])


@pytest.mark.asyncio
async def test_find_no_operands_defaults_to_the_mount_root():
    async def core(path: PathSpec, **_kw) -> list[str]:
        assert path.virtual == "/"
        return ["/a.txt"]

    stdout, io = await find(
        [],
        (),
        find_core=core,
        stat_path=_stat_path(FileStat(name="/", type=FileType.DIRECTORY)),
    )
    assert io.exit_code == 0
    assert stdout == b"/\n/a.txt\n"


@pytest.mark.asyncio
async def test_walk_find_reports_a_directory_it_may_not_open():
    # The guarded readdir refuses a directory a rule holds: the walk
    # keeps its row, names it to the caller that collects such
    # directories, and goes on; a caller that does not collect them is
    # not left with a silent gap.
    tree = {"/": ["/open", "/sealed"], "/open": ["/open/o"]}
    kinds = {
        "/": FileType.DIRECTORY,
        "/open": FileType.DIRECTORY,
        "/sealed": FileType.DIRECTORY,
        "/open/o": FileType.FILE,
    }

    async def readdir(spec, index=None):
        if spec.virtual == "/sealed":
            raise PermissionError("/sealed")
        return tree[spec.virtual]

    async def stat(spec, index=None):
        return FileStat(name=spec.virtual, type=kinds[spec.virtual])

    unreadable: list[str] = []
    results = await walk_find(
        _root_spec(),
        readdir=readdir,
        stat=stat,
        index=None,
        args=FindArgs(),
        unreadable=unreadable,
    )
    assert results == ["/", "/open", "/open/o", "/sealed"]
    assert unreadable == ["/sealed"]
    with pytest.raises(PermissionError):
        await walk_find(
            _root_spec(),
            readdir=readdir,
            stat=stat,
            index=None,
            args=FindArgs(),
        )


@pytest.mark.asyncio
async def test_walk_selection_preserves_newlines_before_rendering():
    stats = {"/mnt": _DIR_STAT, "/mnt/a\nb": _FILE_STAT}
    _, io = await find_walk_generic(
        [_file_spec(virtual="/mnt", key="")],
        ["-type", "f"],
        CommandOpts(stat_path=_stat_map(stats)),
        readdir=AsyncMock(return_value=["/mnt/a\nb"]),
        stat=AsyncMock(side_effect=lambda path, *_: stats[path.virtual]),
    )
    assert io.matched_runs is not None
    assert [p.virtual for run in io.matched_runs for p in run] == ["/mnt/a\nb"]


@pytest.mark.asyncio
async def test_start_point_streams_before_native_walk():
    root = PathSpec.from_str_path("/remote")
    core = AsyncMock(side_effect=AssertionError("must not fetch descendants"))
    probe = AsyncMock(
        return_value=FileStat(name="remote", type=FileType.DIRECTORY)
    )
    out, _ = await stream_find([root], (), find_core=core, stat_path=probe)
    assert await anext(out) == b"/remote\n"
    await out.aclose()
    core.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "size, expected", [(None, b""), (0, b"/mnt/a.txt\n"), (1, b"")]
)
async def test_empty_file_start_requires_known_zero_size(size, expected):
    stdout, _ = await find(
        [PathSpec.from_str_path("/mnt/a.txt", "a.txt")],
        (),
        find_core=_unreached_core,
        stat_path=_stat_path(
            FileStat(name="a.txt", type=FileType.FILE, size=size)
        ),
        empty=True,
    )
    assert stdout == expected


@pytest.mark.asyncio
async def test_empty_walk_does_not_treat_unknown_size_as_zero():
    stat = AsyncMock(
        return_value=FileStat(
            name="records.jsonl", type=FileType.FILE, size=None
        )
    )
    readdir = AsyncMock(return_value=[])
    result = await walk_find(
        PathSpec.from_str_path("/records.jsonl", "records.jsonl"),
        readdir=readdir,
        stat=stat,
        index=None,
        args=FindArgs(empty=True),
    )
    assert result == []
