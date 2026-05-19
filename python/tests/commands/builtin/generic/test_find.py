from dataclasses import asdict
from datetime import datetime, timezone

import pytest

from mirage.commands.builtin.generic.find import (FindArgs, apply_mount_prefix,
                                                  apply_mtime_filter,
                                                  parse_find_args)
from mirage.types import FileStat, FileType, FindType, PathSpec


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


def test_parse_find_args_extracts_not_name_from_texts():
    args = parse_find_args(("-not", "-name", "*.pyc"))
    assert args.name_exclude == "*.pyc"


def test_parse_find_args_extracts_or_names_only_when_multiple():
    """Single `-name` gets a None or_names list (means: just use args.name)."""
    args = parse_find_args(("-or", "-name", "*.py"), name="*.txt")
    assert args.or_names == ["*.txt", "*.py"]


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
