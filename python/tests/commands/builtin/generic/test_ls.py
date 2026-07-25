from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from functools import partial

import pytest

from mirage.commands.builtin.generic.ls import (LS_FAILURE, LS_MINOR_PROBLEM,
                                                LS_OK, LsWarning,
                                                exit_status_for, format_simple,
                                                ls, walk)
from mirage.types import FileStat, FileType, LsSortBy, PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


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
                remainder = key[len(prefix):]
                if "/" not in remainder:
                    children.append(key)
        return sorted(children)

    return readdir, stat


async def _stat_denying(p: PathSpec,
                        index=None,
                        *,
                        stat: Callable[..., Awaitable[FileStat]],
                        blocked: str) -> FileStat:
    if p.virtual == blocked:
        raise PermissionError(13, "Permission denied")
    return await stat(p, index)


async def _readdir_denying(p: PathSpec,
                           index=None,
                           *,
                           readdir: Callable[..., Awaitable[list[str]]],
                           blocked: str) -> list[str]:
    if p.virtual == blocked:
        raise PermissionError(13, "Permission denied")
    return await readdir(p, index)


def _file(name: str, size: int = 0, modified: str | None = None) -> FileStat:
    return FileStat(name=name,
                    size=size,
                    modified=modified,
                    type=FileType.TEXT)


def _dir(name: str) -> FileStat:
    return FileStat(name=name, size=None, type=FileType.DIRECTORY)


def test_format_simple_default_lists_names():
    out = format_simple([_file("a.txt"), _file("b.txt")])
    assert out == ["a.txt", "b.txt"]


def test_format_simple_classify_marks_dirs_with_slash():
    out = format_simple([_file("a.txt"), _dir("sub")], classify=True)
    assert out == ["a.txt", "sub/"]


@pytest.mark.asyncio
async def test_walk_lists_immediate_children():
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt", 3),
        "/dir/b.txt": _file("b.txt", 2),
    }
    readdir, stat = _make_fs_backend(tree)
    res = await walk(_spec("/dir"), readdir=readdir, stat=stat)
    entries = res.entries
    warnings = [w.message for w in res.warnings]
    assert [e.name for e in entries] == ["a.txt", "b.txt"]
    assert warnings == []


@pytest.mark.asyncio
async def test_walk_skips_dotfiles_unless_all_files():
    tree = {
        "/dir": _dir("dir"),
        "/dir/.hidden": _file(".hidden", 1),
        "/dir/visible.txt": _file("visible.txt", 2),
    }
    readdir, stat = _make_fs_backend(tree)
    res = await walk(_spec("/dir"), readdir=readdir, stat=stat)
    entries = res.entries
    assert [e.name for e in entries] == ["visible.txt"]
    res = await walk(_spec("/dir"), readdir=readdir, stat=stat, all_files=True)
    entries = res.entries
    assert sorted(e.name for e in entries) == [".hidden", "visible.txt"]


@pytest.mark.asyncio
async def test_walk_sort_by_size():
    tree = {
        "/dir": _dir("dir"),
        "/dir/big.txt": _file("big.txt", 1000),
        "/dir/small.txt": _file("small.txt", 1),
    }
    readdir, stat = _make_fs_backend(tree)
    res = await walk(_spec("/dir"),
                     readdir=readdir,
                     stat=stat,
                     sort_by=LsSortBy.SIZE)
    entries = res.entries
    assert [e.name for e in entries] == ["big.txt", "small.txt"]
    res = await walk(_spec("/dir"),
                     readdir=readdir,
                     stat=stat,
                     sort_by=LsSortBy.SIZE,
                     reverse=True)
    entries = res.entries
    assert [e.name for e in entries] == ["small.txt", "big.txt"]


@pytest.mark.asyncio
async def test_walk_sort_by_time():
    older = datetime(2024, 1, 1, tzinfo=timezone.utc).isoformat()
    newer = datetime(2025, 1, 1, tzinfo=timezone.utc).isoformat()
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt", 1, modified=older),
        "/dir/b.txt": _file("b.txt", 1, modified=newer),
    }
    readdir, stat = _make_fs_backend(tree)
    res = await walk(_spec("/dir"),
                     readdir=readdir,
                     stat=stat,
                     sort_by=LsSortBy.TIME)
    entries = res.entries
    assert [e.name for e in entries] == ["b.txt", "a.txt"]


@pytest.mark.asyncio
async def test_walk_recursive_descends_into_dirs():
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt"),
        "/dir/sub": _dir("sub"),
        "/dir/sub/b.txt": _file("b.txt"),
    }
    readdir, stat = _make_fs_backend(tree)
    res = await walk(_spec("/dir"), readdir=readdir, stat=stat, recursive=True)
    entries = res.entries
    names = [e.name for e in entries]
    assert "a.txt" in names
    assert "sub" in names
    assert "b.txt" in names


@pytest.mark.asyncio
async def test_walk_list_dir_returns_only_self():
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt"),
    }
    readdir, stat = _make_fs_backend(tree)
    res = await walk(_spec("/dir"), readdir=readdir, stat=stat, list_dir=True)
    entries = res.entries
    # GNU ls -d prints the operand as given.
    assert [e.name for e in entries] == ["/dir"]


@pytest.mark.asyncio
async def test_walk_missing_path_collects_warning():
    readdir, stat = _make_fs_backend({})
    res = await walk(_spec("/nope"), readdir=readdir, stat=stat)
    entries = res.entries
    warnings = [w.message for w in res.warnings]
    assert entries == []
    assert any("/nope" in w for w in warnings)


@pytest.mark.asyncio
async def test_ls_short_output_terminates_record():
    tree = {"/dir": _dir("dir"), "/dir/a.txt": _file("a.txt")}
    readdir, stat = _make_fs_backend(tree)
    output, io = await ls([_spec("/dir")], readdir=readdir, stat=stat)
    assert output == b"a.txt\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_ls_long_format_renders_via_format_ls_long():
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt", 42),
    }
    readdir, stat = _make_fs_backend(tree)
    output, _ = await ls([_spec("/dir")],
                         readdir=readdir,
                         stat=stat,
                         long=True)
    decoded = output.decode()
    assert "a.txt" in decoded
    assert "42" in decoded


@pytest.mark.asyncio
async def test_ls_one_per_line_overrides_long():
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt", 42),
    }
    readdir, stat = _make_fs_backend(tree)
    out_long, _ = await ls([_spec("/dir")],
                           readdir=readdir,
                           stat=stat,
                           long=True,
                           one_per_line=True)
    assert out_long == b"a.txt\n"


@pytest.mark.asyncio
async def test_ls_classify_appends_slash_for_dirs():
    tree = {
        "/dir": _dir("dir"),
        "/dir/sub": _dir("sub"),
        "/dir/a.txt": _file("a.txt"),
    }
    readdir, stat = _make_fs_backend(tree)
    output, _ = await ls([_spec("/dir")],
                         readdir=readdir,
                         stat=stat,
                         classify=True)
    decoded = output.decode().splitlines()
    assert "sub/" in decoded
    assert "a.txt" in decoded


@pytest.mark.asyncio
async def test_ls_missing_operand_exits_2():
    readdir, stat = _make_fs_backend({})
    output, io = await ls([_spec("/nope")], readdir=readdir, stat=stat)
    assert output == b""
    assert io.exit_code == LS_FAILURE
    assert b"/nope" in (io.stderr or b"")


@pytest.mark.asyncio
async def test_ls_missing_operand_exits_2_even_beside_a_good_one():
    """GNU ratchets to 2 for any bad command-line operand, and still lists
    the good ones. Order must not matter.
    """
    tree = {"/dir": _dir("dir"), "/dir/a.txt": _file("a.txt")}
    readdir, stat = _make_fs_backend(tree)
    for paths in ([_spec("/nope"),
                   _spec("/dir")], [_spec("/dir"),
                                    _spec("/nope")]):
        output, io = await ls(paths, readdir=readdir, stat=stat)
        assert io.exit_code == LS_FAILURE
        assert output == b"a.txt\n"


@pytest.mark.asyncio
async def test_ls_missing_operand_under_list_dir_exits_2():
    tree = {"/dir": _dir("dir")}
    readdir, stat = _make_fs_backend(tree)
    _, io = await ls([_spec("/dir"), _spec("/nope")],
                     readdir=readdir,
                     stat=stat,
                     list_dir=True)
    assert io.exit_code == LS_FAILURE


@pytest.mark.asyncio
async def test_ls_unstattable_entry_is_a_minor_problem():
    """An entry below the operand is not a command-line arg, so GNU keeps
    listing its siblings and exits 1.
    """
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt"),
        "/dir/locked.txt": _file("locked.txt"),
    }
    readdir, stat = _make_fs_backend(tree)

    denying_stat = partial(_stat_denying, stat=stat, blocked="/dir/locked.txt")
    output, io = await ls([_spec("/dir")], readdir=readdir, stat=denying_stat)
    assert io.exit_code == LS_MINOR_PROBLEM
    assert output == b"a.txt\n"
    assert b"locked.txt" in (io.stderr or b"")


@pytest.mark.asyncio
async def test_ls_recursive_unreadable_subdir_is_a_minor_problem():
    """GNU exits 1 (not 2) when only a directory met while recursing fails,
    and keeps the parent listing.
    """
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt"),
        "/dir/sub": _dir("sub"),
    }
    readdir, stat = _make_fs_backend(tree)

    denying_readdir = partial(_readdir_denying,
                              readdir=readdir,
                              blocked="/dir/sub")
    output, io = await ls([_spec("/dir")],
                          readdir=denying_readdir,
                          stat=stat,
                          recursive=True)
    assert io.exit_code == LS_MINOR_PROBLEM
    assert b"/dir:" in output
    assert b"a.txt" in output


@pytest.mark.asyncio
async def test_ls_serious_problem_outranks_a_minor_one():
    tree = {
        "/dir": _dir("dir"),
        "/dir/a.txt": _file("a.txt"),
        "/dir/sub": _dir("sub"),
    }
    readdir, stat = _make_fs_backend(tree)

    denying_readdir = partial(_readdir_denying,
                              readdir=readdir,
                              blocked="/dir/sub")
    _, io = await ls([_spec("/dir"), _spec("/nope")],
                     readdir=denying_readdir,
                     stat=stat,
                     recursive=True)
    assert io.exit_code == LS_FAILURE


@pytest.mark.asyncio
async def test_ls_recursive_prints_no_header_for_a_failed_operand():
    tree = {"/dir": _dir("dir"), "/dir/a.txt": _file("a.txt")}
    readdir, stat = _make_fs_backend(tree)
    output, io = await ls([_spec("/dir"), _spec("/nope")],
                          readdir=readdir,
                          stat=stat,
                          recursive=True)
    assert io.exit_code == LS_FAILURE
    assert b"/nope:" not in output
    assert b"/dir:" in output


@pytest.mark.asyncio
async def test_ls_recursive_failed_operand_first_has_no_leading_blank():
    """A failed operand renders no group, so the next one still starts the
    output flush left, the same both operand orders.
    """
    tree = {"/dir": _dir("dir"), "/dir/a.txt": _file("a.txt")}
    readdir, stat = _make_fs_backend(tree)
    output, io = await ls([_spec("/nope"), _spec("/dir")],
                          readdir=readdir,
                          stat=stat,
                          recursive=True)
    assert io.exit_code == LS_FAILURE
    assert output == b"/dir:\na.txt\n"


def test_exit_status_for_ratchets_like_gnu():
    minor = LsWarning("ls: cannot access 'x': Permission denied", False)
    serious = LsWarning("ls: cannot access '/nope': No such file", True)
    assert exit_status_for([]) == LS_OK
    assert exit_status_for([minor]) == LS_MINOR_PROBLEM
    assert exit_status_for([serious]) == LS_FAILURE
    assert exit_status_for([minor, serious]) == LS_FAILURE
    assert exit_status_for([serious, minor]) == LS_FAILURE


@pytest.mark.asyncio
async def test_walk_single_file_lists_itself():
    tree = {"/dir/a.parquet": _file("a.parquet", 5)}
    readdir, stat = _make_fs_backend(tree)
    res = await walk(_spec("/dir/a.parquet"), readdir=readdir, stat=stat)
    entries = res.entries
    warnings = [w.message for w in res.warnings]
    # GNU ls prints a file operand as given.
    assert [e.name for e in entries] == ["/dir/a.parquet"]
    assert warnings == []


@pytest.mark.asyncio
async def test_walk_empty_readdir_falls_back_to_file():
    """Object stores (e.g. s3) return [] for a file key instead of raising."""
    fstat = _file("a.parquet", 5)

    async def stat(p, index=None):
        if p.virtual == "/data/a.parquet":
            return fstat
        raise FileNotFoundError(p.virtual)

    async def readdir(p, _index=None):
        return []

    res = await walk(_spec("/data/a.parquet"), readdir=readdir, stat=stat)
    entries = res.entries
    warnings = [w.message for w in res.warnings]
    assert [e.name for e in entries] == ["/data/a.parquet"]
    assert warnings == []


@pytest.mark.asyncio
async def test_walk_empty_dir_stays_empty():
    tree = {"/empty": _dir("empty")}
    readdir, stat = _make_fs_backend(tree)
    res = await walk(_spec("/empty"), readdir=readdir, stat=stat)
    entries = res.entries
    warnings = [w.message for w in res.warnings]
    assert entries == []
    assert warnings == []


@pytest.mark.asyncio
async def test_ls_file_argument_lists_the_file():
    tree = {"/dir/a.json": _file("a.json", 5)}
    readdir, stat = _make_fs_backend(tree)
    output, io = await ls([_spec("/dir/a.json")], readdir=readdir, stat=stat)
    assert output == b"/dir/a.json\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_ls_l_no_filetype_enrichment():
    tree = {
        "/dir": _dir("dir"),
        "/dir/data.parquet": _file("data.parquet", 999),
    }
    readdir, stat = _make_fs_backend(tree)

    output, _ = await ls(
        [_spec("/dir")],
        readdir=readdir,
        stat=stat,
        long=True,
    )
    decoded = output.decode()
    assert "data.parquet" in decoded
