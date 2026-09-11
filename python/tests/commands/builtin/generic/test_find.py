import asyncio
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.find_eval import Name, Not, Or
from mirage.commands.builtin.generic.find import (FindArgs, apply_mount_prefix,
                                                  apply_mtime_filter, find,
                                                  find_walk_generic,
                                                  parse_find_args, walk_find)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import FindParseError
from mirage.ops.types import LinkView
from mirage.resource.ram import RAMResource
from mirage.types import (ContentType, FileStat, FileType, FindType, MountMode,
                          PathSpec)
from mirage.workspace import Workspace


def _defaults() -> dict:
    return asdict(FindArgs())


def test_parse_find_args_empty_returns_defaults():
    args = parse_find_args(())
    assert asdict(args) == _defaults()


def test_parse_find_args_name_passthrough():
    args = parse_find_args((), name="*.txt")
    assert args.name == "*.txt"
    assert args.or_names is None


def test_parse_find_args_iname_and_path():
    args = parse_find_args((), iname="HELLO.*", path="**/sub/*")
    assert args.iname == "HELLO.*"
    assert args.path_pattern == "**/sub/*"


def test_parse_find_args_maxdepth_mindepth_str_to_int():
    args = parse_find_args((), maxdepth="3", mindepth="1")
    assert args.maxdepth == 3
    assert args.mindepth == 1


def test_parse_find_args_size_plus_lower_bound():
    args = parse_find_args((), size="+500c")
    assert args.min_size == 501
    assert args.max_size is None


def test_parse_find_args_size_minus_upper_bound():
    args = parse_find_args((), size="-1k")
    assert args.min_size is None
    assert args.max_size == 0


def test_parse_find_args_size_exact():
    args = parse_find_args((), size="1k")
    assert args.min_size == 1
    assert args.max_size == 1024


def test_parse_find_args_mtime_minus_recent():
    """`-mtime -1` means modified within last 1 day."""
    args = parse_find_args((), mtime="-1")
    assert args.mtime_min is not None
    assert args.mtime_max is None


def test_parse_find_args_mtime_plus_old():
    args = parse_find_args((), mtime="+7")
    assert args.mtime_min is None
    assert args.mtime_max is not None


def test_parse_find_args_type_canonicalized_to_findtype_enum():
    """Known POSIX `-type` values become FindType members."""
    assert parse_find_args((), type="d").type is FindType.DIRECTORY
    assert parse_find_args((), type="f").type is FindType.FILE


def test_parse_find_args_unknown_type_left_as_string():
    """Non-POSIX types pass through verbatim (allows custom backend types)."""
    assert parse_find_args((), type="symlink").type == "symlink"


def test_parse_find_args_unknown_predicate_raises():
    with pytest.raises(FindParseError,
                       match="find: unknown predicate '-bogus'"):
        parse_find_args(("-bogus", ))


def test_parse_find_args_negation_builds_not_tree():
    args = parse_find_args(("-not", "-name", "*.pyc"))
    assert args.tree == Not(Name("*.pyc"))


def test_parse_find_args_or_builds_or_tree():
    args = parse_find_args(("-name", "*.txt", "-o", "-name", "*.py"))
    assert args.tree == Or([Name("*.txt"), Name("*.py")])


def test_parse_find_args_or_names_none_when_only_one_name():
    """If only `name` is set with no `-or -name` clauses, or_names is None."""
    args = parse_find_args((), name="*.txt")
    assert args.or_names is None


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
async def test_apply_mtime_filter_keeps_within_window():
    now = datetime.now(tz=timezone.utc)
    iso = now.isoformat()

    async def stat(_spec: PathSpec) -> FileStat:
        return FileStat(name="a.txt",
                        size=1,
                        modified=iso,
                        type=FileType.FILE,
                        content=ContentType.TEXT)

    out = await apply_mtime_filter(
        ["/a.txt"],
        mtime_min=now.timestamp() - 60,
        mtime_max=now.timestamp() + 60,
        stat=stat,
    )
    assert out == ["/a.txt"]


@pytest.mark.asyncio
async def test_apply_mtime_filter_stats_the_mounted_virtual_path():
    now = datetime.now(tz=timezone.utc)
    stat = AsyncMock(return_value=FileStat(name="a.txt",
                                           size=1,
                                           modified=now.isoformat(),
                                           type=FileType.FILE,
                                           content=ContentType.TEXT))

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
    assert spec.resource_path == "a.txt"


@pytest.mark.asyncio
async def test_apply_mtime_filter_drops_outside_window():
    old = datetime(2020, 1, 1, tzinfo=timezone.utc)

    async def stat(_spec: PathSpec) -> FileStat:
        return FileStat(name="a.txt",
                        size=1,
                        modified=old.isoformat(),
                        type=FileType.FILE,
                        content=ContentType.TEXT)

    out = await apply_mtime_filter(
        ["/a.txt"],
        mtime_min=datetime(2025, 1, 1, tzinfo=timezone.utc).timestamp(),
        mtime_max=None,
        stat=stat,
    )
    assert out == []


@pytest.mark.asyncio
async def test_apply_mtime_filter_drops_entries_with_no_modified_time():

    async def stat(_spec: PathSpec) -> FileStat:
        return FileStat(name="a.txt",
                        size=1,
                        modified=None,
                        type=FileType.FILE,
                        content=ContentType.TEXT)

    out = await apply_mtime_filter(
        ["/a.txt"],
        mtime_min=1.0,
        mtime_max=None,
        stat=stat,
    )
    assert out == []


@pytest.mark.asyncio
async def test_apply_mtime_filter_honours_a_reported_utc_offset():
    """A backend that reports +09:00 means +09:00, not UTC.

    Stamping UTC over the offset moved the entry nine hours, which is
    enough to push it out of a window it belongs in.
    """
    moment = datetime(2025, 6, 1, 12, 0, tzinfo=timezone(timedelta(hours=9)))

    async def stat(_spec: PathSpec) -> FileStat:
        return FileStat(name="a.txt",
                        size=1,
                        modified=moment.isoformat(),
                        type=FileType.FILE,
                        content=ContentType.TEXT)

    out = await apply_mtime_filter(
        ["/a.txt"],
        mtime_min=moment.timestamp() - 60,
        mtime_max=moment.timestamp() + 60,
        stat=stat,
    )
    assert out == ["/a.txt"]


@pytest.mark.asyncio
async def test_apply_mtime_filter_drops_a_malformed_timestamp():
    """An unparseable stamp drops the entry instead of raising out of find."""

    async def stat(_spec: PathSpec) -> FileStat:
        return FileStat(name="a.txt",
                        size=1,
                        modified="not-a-date",
                        type=FileType.FILE,
                        content=ContentType.TEXT)

    out = await apply_mtime_filter(
        ["/a.txt"],
        mtime_min=1.0,
        mtime_max=None,
        stat=stat,
    )
    assert out == []


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


def test_apply_mount_prefix_noop_when_empty():
    assert apply_mount_prefix(["/a.txt"], "") == ["/a.txt"]


def test_apply_mount_prefix_prepends():
    assert apply_mount_prefix(["/a.txt", "/dir/b.txt"],
                              "/mnt") == ["/mnt/a.txt", "/mnt/dir/b.txt"]


def test_apply_mount_prefix_strips_leading_slash_from_entries():
    assert apply_mount_prefix(["a.txt"], "/mnt") == ["/mnt/a.txt"]


async def _unreached_stat(_spec: PathSpec) -> FileStat:
    raise AssertionError("stat should not be called when no mtime window set")


def _root_spec() -> PathSpec:
    return PathSpec(resource_path="",
                    virtual="/",
                    directory="/",
                    resolved=False)


@pytest.mark.asyncio
async def test_walk_find_tolerates_not_found_readdir():
    readdir = AsyncMock(side_effect=FileNotFoundError("/"))
    stat = AsyncMock(side_effect=FileNotFoundError("/"))
    results = await walk_find(_root_spec(),
                              readdir=readdir,
                              stat=stat,
                              index=None,
                              args=FindArgs())
    assert results == []


@pytest.mark.asyncio
async def test_walk_find_emits_start_path_at_depth_zero():
    readdir = AsyncMock(return_value=["/child.txt"])
    stat = AsyncMock(return_value=FileStat(name="/", type=FileType.DIRECTORY))
    results = await walk_find(_root_spec(),
                              readdir=readdir,
                              stat=stat,
                              index=None,
                              args=FindArgs(maxdepth=0))
    assert results == ["/"]
    readdir.assert_not_awaited()


@pytest.mark.asyncio
async def test_walk_find_propagates_non_not_found_readdir_errors():
    readdir = AsyncMock(side_effect=ValueError("bad page token"))
    # The root has to stat as a directory to be walked at all: a start
    # point that is not one has no children to read.
    stat = AsyncMock(return_value=FileStat(name="/", type=FileType.DIRECTORY))
    with pytest.raises(ValueError, match="bad page token"):
        await walk_find(_root_spec(),
                        readdir=readdir,
                        stat=stat,
                        index=None,
                        args=FindArgs())


@pytest.mark.asyncio
async def test_walk_find_stat_fallback_treats_not_found_as_file():
    readdir = AsyncMock(return_value=["/mystery"])
    stat = AsyncMock(side_effect=FileNotFoundError("/mystery"))
    results = await walk_find(_root_spec(),
                              readdir=readdir,
                              stat=stat,
                              index=None,
                              args=FindArgs(type=FindType.FILE))
    assert results == ["/mystery"]


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
            "/":
            FileStat(name="/", type=FileType.DIRECTORY),
            "/empty.txt":
            FileStat(name="empty.txt",
                     size=0,
                     type=FileType.FILE,
                     content=ContentType.TEXT),
            "/full.txt":
            FileStat(name="full.txt",
                     size=1,
                     type=FileType.FILE,
                     content=ContentType.TEXT),
            "/empty-dir":
            FileStat(name="empty-dir", type=FileType.DIRECTORY),
            "/full-dir":
            FileStat(name="full-dir", type=FileType.DIRECTORY),
            "/full-dir/a.txt":
            FileStat(name="a.txt",
                     size=1,
                     type=FileType.FILE,
                     content=ContentType.TEXT),
        }
        return stats[spec.virtual]

    results = await walk_find(_root_spec(),
                              readdir=readdir,
                              stat=stat,
                              index=None,
                              args=parse_find_args(("-empty", )))
    assert results == ["/empty-dir", "/empty.txt"]


@pytest.mark.asyncio
async def test_walk_find_not_negates_predicate():
    readdir = AsyncMock(return_value=["/a.txt", "/b.md"])

    async def stat(spec: PathSpec, _index):
        if spec.virtual == "/":
            return FileStat(name="/", type=FileType.DIRECTORY)
        return FileStat(name=spec.virtual.rsplit("/", 1)[-1],
                        size=1,
                        type=FileType.FILE,
                        content=ContentType.TEXT)

    results = await walk_find(_root_spec(),
                              readdir=readdir,
                              stat=stat,
                              index=None,
                              args=parse_find_args(("-not", "-name", "*.txt")))
    assert results == ["/", "/b.md"]


@pytest.mark.asyncio
async def test_walk_find_stat_fallback_propagates_other_errors():
    readdir = AsyncMock(return_value=["/mystery"])
    stat = AsyncMock(side_effect=ValueError("rate limited"))
    with pytest.raises(ValueError, match="rate limited"):
        await walk_find(_root_spec(),
                        readdir=readdir,
                        stat=stat,
                        index=None,
                        args=FindArgs())


@pytest.mark.asyncio
async def test_walk_find_size_filter_drops_not_found_entries():
    readdir = AsyncMock(return_value=["/a.json"])
    stat = AsyncMock(side_effect=FileNotFoundError("/a.json"))
    results = await walk_find(_root_spec(),
                              readdir=readdir,
                              stat=stat,
                              index=None,
                              args=FindArgs(min_size=1))
    assert results == []


@pytest.mark.asyncio
async def test_walk_find_size_filter_propagates_other_stat_errors():
    readdir = AsyncMock(return_value=["/a.json"])
    stat = AsyncMock(side_effect=ValueError("rate limited"))
    with pytest.raises(ValueError, match="rate limited"):
        await walk_find(_root_spec(),
                        readdir=readdir,
                        stat=stat,
                        index=None,
                        args=FindArgs(min_size=1))


@pytest.mark.parametrize("kwargs,flag,value", [
    ({
        "maxdepth": "abc"
    }, "-maxdepth", "abc"),
    ({
        "mindepth": "xx"
    }, "-mindepth", "xx"),
    ({
        "size": ""
    }, "-size", ""),
    ({
        "size": "abc"
    }, "-size", "abc"),
    ({
        "mtime": "abc"
    }, "-mtime", "abc"),
])
def test_parse_find_args_invalid_numeric_raises_find_parse_error(
        kwargs, flag, value):
    with pytest.raises(FindParseError) as exc:
        parse_find_args((), **kwargs)
    assert str(exc.value) == f"find: invalid argument '{value}' to '{flag}'"


@pytest.mark.parametrize("expr", [
    "-maxdepth abc",
    "-mindepth xx",
    "-size ''",
    "-size abc",
    "-mtime abc",
])
def test_find_invalid_numeric_arg_exits_one_with_clean_stderr(expr):

    async def _go() -> tuple[int, str]:
        ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
        ws.create_session("s")
        r = await ws.execute(f"find / {expr}", session_id="s")
        return r.exit_code, await r.stderr_str()

    code, stderr = asyncio.run(_go())
    assert code == 1
    assert stderr.startswith("find: invalid argument ")
    assert stderr.endswith("\n")


# ── Issue #312 parse-level regression tests ────────────────


def test_parse_find_args_start_path_included():
    args = parse_find_args(())
    assert args.maxdepth is None


def test_parse_find_args_maxdepth_zero():
    args = parse_find_args(("-maxdepth", "0"))
    assert args.maxdepth == 0


def test_parse_find_args_empty_predicate():
    args = parse_find_args(("-empty", ))
    assert args.empty is True


def test_parse_find_args_not_negation():
    args = parse_find_args(("-not", "-name", "*.txt"))
    assert isinstance(args.tree, Not)
    assert isinstance(args.tree.kid, Name)
    assert args.tree.kid.pattern == "*.txt"


def test_parse_find_args_bogus_predicate_raises():
    with pytest.raises(FindParseError, match="unknown predicate"):
        parse_find_args(("-boguspredicate", ))


def _file_spec(virtual: str = "/mnt/a.txt", key: str = "a.txt") -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual[:virtual.rfind("/") + 1],
                    resource_path=key)


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
async def test_find_file_start_point_is_reported_not_walked():
    """A start point that is not a directory never reaches the backend.

    Every backend answered a walk of one differently: an object store
    listed the key as a prefix and returned nothing, Graph 404'd on the
    children of a file, and Box raised ENOTDIR.
    """
    stdout, io = await find(
        [_file_spec()],
        (),
        find_core=_unreached_core,
        stat_path=_stat_path(
            FileStat(name="a.txt",
                     size=6,
                     type=FileType.FILE,
                     content=ContentType.TEXT)),
    )
    assert io.exit_code == 0
    assert stdout == b"/mnt/a.txt\n"


@pytest.mark.asyncio
async def test_find_file_start_point_type_filters():
    start = FileStat(name="a.txt",
                     size=6,
                     type=FileType.FILE,
                     content=ContentType.TEXT)
    for ftype, expected in (("f", b"/mnt/a.txt\n"), ("d", b""), ("l", b"")):
        stdout, io = await find([_file_spec()], ("-type", ftype),
                                find_core=_unreached_core,
                                stat_path=_stat_path(start))
        assert io.exit_code == 0
        assert stdout == expected, f"-type {ftype}"


@pytest.mark.asyncio
async def test_find_file_start_point_depth_and_size():
    start = FileStat(name="a.txt",
                     size=6,
                     type=FileType.FILE,
                     content=ContentType.TEXT)
    cases = [
        ({
            "maxdepth": "0"
        }, b"/mnt/a.txt\n"),
        ({
            "mindepth": "1"
        }, b""),
        ({
            "size": "+1c"
        }, b"/mnt/a.txt\n"),
        ({
            "size": "+99c"
        }, b""),
        ({
            "name": "a.txt"
        }, b"/mnt/a.txt\n"),
        ({
            "name": "nope"
        }, b""),
        # The flag form passes the value through, so `-type l` (a namespace
        # symlink, which no backend entry ever is) filters instead of
        # reading as "no filter" and printing everything.
        ({
            "type": "f"
        }, b"/mnt/a.txt\n"),
        ({
            "type": "d"
        }, b""),
        ({
            "type": "l"
        }, b""),
    ]
    for flags, expected in cases:
        stdout, io = await find([_file_spec()], (),
                                find_core=_unreached_core,
                                stat_path=_stat_path(start),
                                **flags)
        assert io.exit_code == 0
        assert stdout == expected, f"{flags}"


@pytest.mark.asyncio
async def test_find_file_start_point_respells_the_operand():
    """The row is printed as the operand was typed.

    That is what makes `find -L <link>` name the link rather than the
    target the router resolved it to.
    """
    spec = PathSpec(virtual="/mnt/a.txt",
                    directory="/mnt/",
                    resource_path="a.txt",
                    raw_path="/other/link.txt")
    stdout, _ = await find(
        [spec],
        (),
        find_core=_unreached_core,
        stat_path=_stat_path(
            FileStat(name="a.txt",
                     size=6,
                     type=FileType.FILE,
                     content=ContentType.TEXT)),
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
    stdout, io = await find([_file_spec(virtual="/mnt/nope", key="nope")], (),
                            find_core=_unreached_core,
                            stat_path=_stat_path(None))
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

    stdout, io = await find([_file_spec(virtual="/mnt/nope", key="nope")], (),
                            find_core=_unreached_core,
                            stat=stat)
    assert io.exit_code == 1
    assert stdout == b""
    assert io.stderr == b"find: '/mnt/nope': No such file or directory\n"


@pytest.mark.asyncio
async def test_find_directory_start_point_still_walks():

    async def core(*_a, **_kw) -> list[str]:
        return ["/", "/a.txt"]

    stdout, io = await find(
        [
            PathSpec(virtual="/mnt",
                     directory="/",
                     resource_path="",
                     resolved=False)
        ],
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
async def test_find_empty_directory_start_point_is_reported():
    """GNU names a directory start point that holds nothing.

    A prefix store answers an empty directory with an empty listing, so
    every native find op that read existence off its own listing reported
    nothing at all for a directory `test -d` and `tree` both saw.
    """

    async def core(*_a, **_kw) -> list[str]:
        return []

    stdout, io = await find(
        [PathSpec(virtual="/mnt", directory="/", resource_path="")],
        (),
        find_core=core,
        stat_path=_stat_path(FileStat(name="mnt", type=FileType.DIRECTORY)),
    )
    assert io.exit_code == 0
    assert stdout == b"/mnt\n"


@pytest.mark.asyncio
async def test_find_empty_directory_start_point_matches_empty():
    """``-empty`` matches it, answered by a listing rather than a guess."""

    async def core(*_a, **_kw) -> list[str]:
        return []

    stdout, io = await find(
        [PathSpec(virtual="/mnt", directory="/", resource_path="")],
        (),
        find_core=core,
        stat_path=_stat_path(FileStat(name="mnt", type=FileType.DIRECTORY)),
        dir_empty=_dir_is_empty,
        empty=True,
    )
    assert io.exit_code == 0
    assert stdout == b"/mnt\n"


@pytest.mark.asyncio
async def test_find_populated_directory_start_point_fails_empty():
    """A directory with children is not empty, so ``-empty`` skips it."""

    async def core(*_a, **_kw) -> list[str]:
        return []

    stdout, io = await find(
        [PathSpec(virtual="/mnt", directory="/", resource_path="")],
        (),
        find_core=core,
        stat_path=_stat_path(FileStat(name="mnt", type=FileType.DIRECTORY)),
        dir_empty=_dir_has_entries,
        empty=True,
    )
    assert io.exit_code == 0
    assert stdout == b""


@pytest.mark.asyncio
async def test_find_keeps_the_backend_row_when_emptiness_cannot_be_asked():
    """A caller with no emptiness probe keeps its own core's answer.

    ``-empty`` on a directory needs a listing, which a bespoke wrapper
    need not wire. Replacing the row there would trade a backend's
    answer for "unknown", so the row is left alone.
    """

    async def core(*_a, **_kw) -> list[str]:
        return ["/"]

    stdout, io = await find(
        [PathSpec(virtual="/mnt", directory="/", resource_path="")],
        (),
        find_core=core,
        stat_path=_stat_path(FileStat(name="mnt", type=FileType.DIRECTORY)),
        empty=True,
    )
    assert io.exit_code == 0
    assert stdout == b"/mnt\n"


@pytest.mark.asyncio
async def test_find_replaces_the_backend_row_for_the_start_point():
    """The backend's own row for the start point is dropped, not merged.

    ssh reports every directory as non-empty, so merging would keep its
    row and print a directory that ``-not -empty`` must skip.
    """

    async def core(*_a, **_kw) -> list[str]:
        return ["/"]

    stdout, io = await find(
        [PathSpec(virtual="/mnt", directory="/", resource_path="")],
        ("-not", "-empty"),
        find_core=core,
        stat_path=_stat_path(FileStat(name="mnt", type=FileType.DIRECTORY)),
        dir_empty=_dir_is_empty,
    )
    assert io.exit_code == 0
    assert stdout == b""


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
        [PathSpec(virtual="/mnt", directory="/", resource_path="")],
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

    async def fn(virtual: str) -> FileStat | None:
        return stats.get(virtual)

    return fn


_DIR_STAT = FileStat(name="d", type=FileType.DIRECTORY)
_FILE_STAT = FileStat(name="f",
                      size=6,
                      type=FileType.FILE,
                      content=ContentType.TEXT)

# GNU findutils 4.10.0, pinned on debian:stable-slim:
#   find A B           -> A's rows, then B's rows (operand order, never
#                         re-sorted across operands)
#   find A A           -> A's rows twice (no dedupe)
#   find A <missing> B -> A's and B's rows still print, the missing
#                         operand gets the diagnostic, and find exits 1


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
        stat_path=_stat_map({
            "/mnt/sub": _DIR_STAT,
            "/mnt/a.txt": _FILE_STAT
        }),
    )
    assert io.exit_code == 0
    # /mnt/a.txt sorts before /mnt/sub; operand order must win anyway.
    assert stdout == b"/mnt/sub\n/mnt/sub/z.txt\n/mnt/a.txt\n"
    # The file start point is reported, never walked.
    assert calls == ["/mnt/sub"]


@pytest.mark.asyncio
async def test_find_duplicate_start_points_walk_twice():

    async def core(_path: PathSpec, **_kw) -> list[str]:
        return ["/sub/z.txt"]

    root = _file_spec(virtual="/mnt/sub", key="sub")
    stdout, io = await find([root, root], (),
                            find_core=core,
                            stat_path=_stat_map({"/mnt/sub": _DIR_STAT}))
    assert io.exit_code == 0
    assert stdout == b"/mnt/sub\n/mnt/sub/z.txt\n" * 2


@pytest.mark.asyncio
async def test_find_missing_middle_operand_keeps_partial_output():
    """The rows already found survive a missing operand (GNU).

    The native-op path used to return the diagnostic alone, discarding
    every other operand's rows along with the missing one's.
    """

    async def core(path: PathSpec, **_kw) -> list[str]:
        return ["/sub/z.txt"] if path.virtual == "/mnt/sub" else []

    stdout, io = await find(
        [
            _file_spec(virtual="/mnt/sub", key="sub"),
            _file_spec(virtual="/mnt/nope", key="nope"),
            _file_spec(virtual="/mnt/a.txt", key="a.txt"),
        ],
        (),
        find_core=core,
        stat_path=_stat_map({
            "/mnt/sub": _DIR_STAT,
            "/mnt/a.txt": _FILE_STAT
        }),
    )
    assert io.exit_code == 1
    assert stdout == b"/mnt/sub\n/mnt/sub/z.txt\n/mnt/a.txt\n"
    assert io.stderr == b"find: '/mnt/nope': No such file or directory\n"


@pytest.mark.asyncio
async def test_find_no_operands_defaults_to_the_mount_root():

    async def core(path: PathSpec, **_kw) -> list[str]:
        assert path.virtual == "/"
        return ["/a.txt"]

    stdout, io = await find([], (),
                            find_core=core,
                            stat_path=_stat_path(
                                FileStat(name="/", type=FileType.DIRECTORY)))
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
    results = await walk_find(_root_spec(),
                              readdir=readdir,
                              stat=stat,
                              index=None,
                              args=FindArgs(),
                              unreadable=unreadable)
    assert results == ["/", "/open", "/open/o", "/sealed"]
    assert unreadable == ["/sealed"]
    with pytest.raises(PermissionError):
        await walk_find(_root_spec(),
                        readdir=readdir,
                        stat=stat,
                        index=None,
                        args=FindArgs())


@pytest.mark.asyncio
async def test_walk_selection_preserves_newlines_before_rendering():
    stats = {"/mnt": _DIR_STAT, "/mnt/a\nb": _FILE_STAT}
    _, io = await find_walk_generic(
        [_file_spec(virtual="/mnt", key="")], ["-type", "f"],
        CommandOpts(stat_path=_stat_map(stats)),
        readdir=AsyncMock(return_value=["/mnt/a\nb"]),
        stat=AsyncMock(side_effect=lambda path, *_: stats[path.virtual]))
    assert io.matched_runs is not None
    assert [p.virtual for run in io.matched_runs for p in run] == ["/mnt/a\nb"]
