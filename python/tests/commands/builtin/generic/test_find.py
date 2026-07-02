import asyncio
from dataclasses import asdict
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.find_eval import Name, Not, Or
from mirage.commands.builtin.generic.find import (FindArgs, apply_mount_prefix,
                                                  apply_mtime_filter,
                                                  parse_find_args, walk_find)
from mirage.commands.errors import FindParseError
from mirage.resource.ram import RAMResource
from mirage.types import FileStat, FileType, FindType, MountMode, PathSpec
from mirage.utils.key_prefix import mount_key
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
    assert args.min_size == 500
    assert args.max_size is None


def test_parse_find_args_size_minus_upper_bound():
    args = parse_find_args((), size="-1k")
    assert args.min_size is None
    assert args.max_size == 1024


def test_parse_find_args_size_exact():
    args = parse_find_args((), size="1k")
    assert args.min_size == 1024
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
        return FileStat(name="a.txt", size=1, modified=iso, type=FileType.TEXT)

    out = await apply_mtime_filter(
        ["/a.txt"],
        mtime_min=now.timestamp() - 60,
        mtime_max=now.timestamp() + 60,
        stat=stat,
    )
    assert out == ["/a.txt"]


@pytest.mark.asyncio
async def test_apply_mtime_filter_drops_outside_window():
    old = datetime(2020, 1, 1, tzinfo=timezone.utc)

    async def stat(_spec: PathSpec) -> FileStat:
        return FileStat(name="a.txt",
                        size=1,
                        modified=old.isoformat(),
                        type=FileType.TEXT)

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
                        type=FileType.TEXT)

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
    return PathSpec(resource_path=mount_key("/", ""),
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
                              is_dir_name=lambda c: None,
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
                              is_dir_name=lambda c: False,
                              index=None,
                              args=FindArgs(maxdepth=0))
    assert results == ["/"]
    readdir.assert_not_awaited()


@pytest.mark.asyncio
async def test_walk_find_propagates_non_not_found_readdir_errors():
    readdir = AsyncMock(side_effect=ValueError("bad page token"))
    stat = AsyncMock()
    with pytest.raises(ValueError, match="bad page token"):
        await walk_find(_root_spec(),
                        readdir=readdir,
                        stat=stat,
                        is_dir_name=lambda c: None,
                        index=None,
                        args=FindArgs())


@pytest.mark.asyncio
async def test_walk_find_stat_fallback_treats_not_found_as_file():
    readdir = AsyncMock(return_value=["/mystery"])
    stat = AsyncMock(side_effect=FileNotFoundError("/mystery"))
    results = await walk_find(_root_spec(),
                              readdir=readdir,
                              stat=stat,
                              is_dir_name=lambda c: None,
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
            "/": FileStat(name="/", type=FileType.DIRECTORY),
            "/empty.txt": FileStat(name="empty.txt",
                                   size=0,
                                   type=FileType.TEXT),
            "/full.txt": FileStat(name="full.txt", size=1, type=FileType.TEXT),
            "/empty-dir": FileStat(name="empty-dir", type=FileType.DIRECTORY),
            "/full-dir": FileStat(name="full-dir", type=FileType.DIRECTORY),
            "/full-dir/a.txt": FileStat(name="a.txt",
                                        size=1,
                                        type=FileType.TEXT),
        }
        return stats[spec.virtual]

    results = await walk_find(_root_spec(),
                              readdir=readdir,
                              stat=stat,
                              is_dir_name=lambda c: c.endswith("dir"),
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
                        type=FileType.TEXT)

    results = await walk_find(_root_spec(),
                              readdir=readdir,
                              stat=stat,
                              is_dir_name=lambda c: False,
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
                        is_dir_name=lambda c: None,
                        index=None,
                        args=FindArgs())


@pytest.mark.asyncio
async def test_walk_find_size_filter_drops_not_found_entries():
    readdir = AsyncMock(return_value=["/a.json"])
    stat = AsyncMock(side_effect=FileNotFoundError("/a.json"))
    results = await walk_find(_root_spec(),
                              readdir=readdir,
                              stat=stat,
                              is_dir_name=lambda c: False,
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
                        is_dir_name=lambda c: False,
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
