from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from functools import partial

import pytest

from mirage.commands.builtin.generic.ls import (LS_FAILURE, LS_MINOR_PROBLEM,
                                                LS_OK, LsWarning,
                                                exit_status_for, filevercmp,
                                                format_simple, ls, parse_flags,
                                                sort_stats, walk)
from mirage.commands.builtin.utils.formatting import BlockSize, LsColumns
from mirage.commands.errors import UsageError
from mirage.ops.types import LinkView, MountView
from mirage.types import (LINK_TARGET_KEY, ContentType, FileStat, FileType,
                          LsSortBy, LsTimeKind, PathSpec)


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
                    type=FileType.FILE,
                    content=ContentType.TEXT)


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
    the good ones. Order must not matter. Two operands means the survivor is
    still headed, exactly as GNU prints it.
    """
    tree = {"/dir": _dir("dir"), "/dir/a.txt": _file("a.txt")}
    readdir, stat = _make_fs_backend(tree)
    for paths in ([_spec("/nope"),
                   _spec("/dir")], [_spec("/dir"),
                                    _spec("/nope")]):
        output, io = await ls(paths, readdir=readdir, stat=stat)
        assert io.exit_code == LS_FAILURE
        assert output == b"/dir:\na.txt\n"


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
    # GNU words a directory it may not read as one it could not open,
    # not as one it could not reach.
    assert io.stderr == (b"ls: cannot open directory '/dir/sub': "
                         b"Permission denied\n")


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


def _two_dir_tree() -> dict[str, FileStat]:
    return {
        "/a": _dir("a"),
        "/a/f.txt": _file("f.txt", 3),
        "/a/sub": _dir("sub"),
        "/b": _dir("b"),
        "/b/g.txt": _file("g.txt", 3),
        "/c": _dir("c"),
        "/mfile": _file("mfile", 1),
        "/zfile": _file("zfile", 1),
    }


@pytest.mark.asyncio
async def test_ls_single_dir_operand_has_no_header():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, _ = await ls([_spec("/a")], readdir=readdir, stat=stat)
    assert output == b"f.txt\nsub\n"


@pytest.mark.asyncio
async def test_ls_two_dir_operands_print_headers_separated_by_blank():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, io = await ls([_spec("/a"), _spec("/b")],
                          readdir=readdir,
                          stat=stat)
    assert output == b"/a:\nf.txt\nsub\n\n/b:\ng.txt\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_ls_empty_dir_operand_still_gets_a_header():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, _ = await ls([_spec("/b"), _spec("/c")],
                         readdir=readdir,
                         stat=stat)
    assert output == b"/b:\ng.txt\n\n/c:\n"


@pytest.mark.asyncio
async def test_ls_file_operands_print_first_without_headers():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, _ = await ls(
        [_spec("/b"),
         _spec("/zfile"),
         _spec("/a"),
         _spec("/mfile")],
        readdir=readdir,
        stat=stat)
    assert output == (b"/mfile\n/zfile\n"
                      b"\n/a:\nf.txt\nsub\n"
                      b"\n/b:\ng.txt\n")


@pytest.mark.asyncio
async def test_ls_only_file_operands_emit_no_trailing_blank():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, _ = await ls([_spec("/zfile"), _spec("/mfile")],
                         readdir=readdir,
                         stat=stat)
    assert output == b"/mfile\n/zfile\n"


@pytest.mark.asyncio
async def test_ls_operands_sort_by_name_not_command_line_order():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, _ = await ls([_spec("/b"), _spec("/a")],
                         readdir=readdir,
                         stat=stat)
    assert output == b"/a:\nf.txt\nsub\n\n/b:\ng.txt\n"


@pytest.mark.asyncio
async def test_ls_reverse_flips_operand_and_entry_order():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, _ = await ls([_spec("/a"), _spec("/b")],
                         readdir=readdir,
                         stat=stat,
                         reverse=True)
    assert output == b"/b:\ng.txt\n\n/a:\nsub\nf.txt\n"


@pytest.mark.asyncio
async def test_ls_failed_operand_still_headers_the_one_that_listed():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, io = await ls([_spec("/nope"), _spec("/a")],
                          readdir=readdir,
                          stat=stat)
    assert output == b"/a:\nf.txt\nsub\n"
    # The header is output, not evidence of success: the bad operand still
    # ratchets the status to 2.
    assert io.exit_code == LS_FAILURE
    assert b"/nope" in (io.stderr or b"")


@pytest.mark.asyncio
async def test_ls_repeated_operand_lists_twice():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, _ = await ls([_spec("/a"), _spec("/a")],
                         readdir=readdir,
                         stat=stat)
    assert output == b"/a:\nf.txt\nsub\n\n/a:\nf.txt\nsub\n"


@pytest.mark.asyncio
async def test_ls_recursive_single_operand_keeps_its_header():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, _ = await ls([_spec("/a")],
                         readdir=readdir,
                         stat=stat,
                         recursive=True)
    assert output == b"/a:\nf.txt\nsub\n\n/a/sub:\n"


@pytest.mark.asyncio
async def test_ls_recursive_file_operand_is_not_headed():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, _ = await ls([_spec("/a"), _spec("/zfile")],
                         readdir=readdir,
                         stat=stat,
                         recursive=True)
    assert output == b"/zfile\n\n/a:\nf.txt\nsub\n\n/a/sub:\n"


@pytest.mark.asyncio
async def test_ls_list_dir_sorts_operands_and_stays_unheaded():
    readdir, stat = _make_fs_backend(_two_dir_tree())
    output, _ = await ls(
        [_spec("/zfile"), _spec("/b"),
         _spec("/a")],
        readdir=readdir,
        stat=stat,
        list_dir=True)
    assert output == b"/a\n/b\n/zfile\n"


def _tied_tree() -> dict[str, FileStat]:
    stamp = datetime(2024, 1, 1, tzinfo=timezone.utc).isoformat()
    return {
        "/a": _file("a", 2, modified=stamp),
        "/b": _file("b", 2, modified=stamp),
        "/c": _file("c", 2, modified=stamp),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("sort_by", [LsSortBy.TIME, LsSortBy.SIZE])
async def test_ls_tied_operands_break_on_name(sort_by):
    """GNU's -t/-S comparators fall back to the name on a tie."""
    readdir, stat = _make_fs_backend(_tied_tree())
    output, _ = await ls(
        [_spec("/c"), _spec("/a"), _spec("/b")],
        readdir=readdir,
        stat=stat,
        sort_by=sort_by)
    assert output == b"/a\n/b\n/c\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("sort_by", [LsSortBy.TIME, LsSortBy.SIZE])
async def test_ls_reverse_flips_the_tie_break_too(sort_by):
    """`-r` negates the whole comparison, so tied names come out descending."""
    readdir, stat = _make_fs_backend(_tied_tree())
    output, _ = await ls(
        [_spec("/c"), _spec("/a"), _spec("/b")],
        readdir=readdir,
        stat=stat,
        sort_by=sort_by,
        reverse=True)
    assert output == b"/c\n/b\n/a\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("sort_by", [LsSortBy.TIME, LsSortBy.SIZE])
async def test_ls_tied_entries_break_on_name(sort_by):
    stamp = datetime(2024, 1, 1, tzinfo=timezone.utc).isoformat()
    tree = {
        "/dir": _dir("dir"),
        "/dir/b.txt": _file("b.txt", 2, modified=stamp),
        "/dir/a.txt": _file("a.txt", 2, modified=stamp),
    }
    readdir, stat = _make_fs_backend(tree)
    output, _ = await ls([_spec("/dir")],
                         readdir=readdir,
                         stat=stat,
                         sort_by=sort_by)
    assert output == b"a.txt\nb.txt\n"
    output, _ = await ls([_spec("/dir")],
                         readdir=readdir,
                         stat=stat,
                         sort_by=sort_by,
                         reverse=True)
    assert output == b"b.txt\na.txt\n"


@pytest.mark.asyncio
async def test_ls_long_widths_are_per_directory_block():
    tree = {
        "/a": _dir("a"),
        "/a/big.txt": _file("big.txt", 1000),
        "/b": _dir("b"),
        "/b/small.txt": _file("small.txt", 1),
    }
    readdir, stat = _make_fs_backend(tree)
    output, _ = await ls([_spec("/a"), _spec("/b")],
                         readdir=readdir,
                         stat=stat,
                         long=True)
    lines = output.decode().splitlines()
    assert lines[0] == "/a:"
    assert " 1000 " in lines[1]
    assert lines[2] == ""
    assert lines[3] == "/b:"
    # GNU sizes its columns per block, so /b is not padded to /a's width.
    assert " 1 " in lines[4]
    assert "    1 " not in lines[4]


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


def _mount_view(*roots: str) -> MountView:
    """A mount table holding exactly ``roots``.

    Only ``is_root`` is exercised: it is what tells a nested mount's root
    (whose listing belongs to another backend) from a directory the
    namespace merely owes children, which -R must still descend.
    """
    return MountView(descendants=lambda p:
                     [r for r in roots if r.startswith(p.rstrip("/") + "/")],
                     visible_descendants=lambda p:
                     [r for r in roots if r.startswith(p.rstrip("/") + "/")],
                     is_root=lambda p: p.rstrip("/") in roots,
                     root_of=lambda p: "/")


def _link_view(link: FileStat) -> LinkView:
    """A namespace holding exactly one link, named flink."""

    async def _exists(virtual: str) -> bool:
        return True

    async def _target_stat(virtual: str) -> FileStat | None:
        return None

    return LinkView(stat_at=lambda v: link if v.endswith("flink") else None,
                    children=lambda d: [],
                    subtree=lambda d: [],
                    resolve=lambda v: v,
                    exists=_exists,
                    target_stat=_target_stat)


_LINK_ROW = FileStat(name="flink",
                     size=19,
                     modified="2026-01-02T15:30:00Z",
                     type=FileType.SYMLINK,
                     extra={LINK_TARGET_KEY: "/data/symx/real.txt"})


@pytest.mark.asyncio
async def test_link_operand_on_a_backend_whose_readdir_raises():

    async def readdir(p, index=None):
        raise FileNotFoundError(p.virtual)

    async def stat(p, index=None):
        raise FileNotFoundError(p.virtual)

    out, io = await ls([PathSpec.from_str_path("/data/symx/flink")],
                       readdir=readdir,
                       stat=stat,
                       long=True,
                       links=_link_view(_LINK_ROW))
    assert io.exit_code == 0
    assert out.decode().strip().endswith("flink -> /data/symx/real.txt")


@pytest.mark.asyncio
async def test_structure_only_directory_lists_its_children():
    """A directory no backend serves still lists when the namespace owes
    it children (a nested mount, a link's ancestors): the door already
    names it in the parent listing, so ls must agree instead of
    reporting it missing."""

    async def readdir(p, index=None):
        raise FileNotFoundError(p.virtual)

    async def stat(p, index=None):
        raise FileNotFoundError(p.virtual)

    def child_mounts(parent: str) -> list[str]:
        return ["deep"] if parent == "/ghost" else []

    out, io = await ls([PathSpec.from_str_path("/ghost")],
                       readdir=readdir,
                       stat=stat,
                       child_mounts=child_mounts)
    assert io.exit_code == 0
    assert out.decode() == "deep\n"


@pytest.mark.asyncio
async def test_structure_only_directory_renders_group_under_recursive():
    """Under -R the group still renders from the namespace fact; only
    descent into the mount root is withheld, because that listing is
    another backend's and the cross-mount fan-out assembles it."""

    async def readdir(p, index=None):
        raise FileNotFoundError(p.virtual)

    async def stat(p, index=None):
        raise FileNotFoundError(p.virtual)

    def child_mounts(parent: str) -> list[str]:
        return ["deep"] if parent == "/ghost" else []

    out, io = await ls([PathSpec.from_str_path("/ghost")],
                       readdir=readdir,
                       stat=stat,
                       recursive=True,
                       child_mounts=child_mounts,
                       mounts=_mount_view("/ghost/deep"))
    assert io.exit_code == 0
    assert out.decode() == "/ghost:\ndeep\n"


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

    out, io = await ls([PathSpec.from_str_path("/ghost")],
                       readdir=readdir,
                       stat=stat,
                       recursive=True,
                       child_mounts=child_mounts,
                       mounts=_mount_view("/ghost/deep/lnk"))
    assert io.exit_code == 0
    assert out.decode() == "/ghost:\ndeep\n\n/ghost/deep:\nlnk\n"


@pytest.mark.asyncio
async def test_mount_root_is_listed_but_not_descended_under_recursive():
    """A mount root is an ordinary entry of a backend-served directory.

    GNU (coreutils 9.7, tmpfs at `base/nested`) prints `nested` in
    `base`'s own listing and then its group. The merge used to be
    withheld whenever the walk was recursive, on the theory that the
    cross-mount fan-out contributed the whole nested mount; it
    contributes the group, not the parent's row, so the row went missing
    wherever the backend held no key of that name. Descent is what the
    fan-out owns, and the mount table is what says where to stop.
    """
    tree = {
        "/base": _dir("base"),
        "/base/top.txt": _file("top.txt", 2),
    }
    readdir, stat = _make_fs_backend(tree)
    out, io = await ls([PathSpec.from_str_path("/base")],
                       readdir=readdir,
                       stat=stat,
                       recursive=True,
                       child_mounts=lambda d: ["nested"]
                       if d == "/base" else [],
                       mounts=_mount_view("/base/nested"))
    assert io.exit_code == 0
    assert out.decode() == "/base:\nnested\ntop.txt\n"


@pytest.mark.asyncio
async def test_a_child_mount_serving_one_file_is_not_a_directory_row():
    """A mount root is not always a directory.

    Every workspace mounts `/.bash_history` as a whole mount serving one
    file, and no backend can stat it: the parent's cannot see into the
    child mount and the child's own calls its root `/`. Synthesizing the
    row as a directory suffixed it with `/` under -F, rendered it
    `drwxr-xr-x` under -l, and offered it to -R as something to descend.
    GNU (coreutils 9.7, `mount --bind` of one file onto another) lists it
    as an ordinary file row of its parent.
    """
    tree = {
        "/base": _dir("base"),
        "/base/top.txt": _file("top.txt", 2),
    }
    readdir, stat = _make_fs_backend(tree)

    async def stat_path(virtual: str) -> FileStat | None:
        if virtual != "/base/hist":
            return None
        # The child mount answers its own root with its name for it.
        return _file("/", 7)

    out, io = await ls([PathSpec.from_str_path("/base")],
                       readdir=readdir,
                       stat=stat,
                       recursive=True,
                       classify=True,
                       child_mounts=lambda d: ["hist"] if d == "/base" else [],
                       mounts=_mount_view("/base/hist"),
                       stat_path=stat_path)
    assert io.exit_code == 0
    assert out.decode() == "/base:\nhist\ntop.txt\n"


@pytest.mark.asyncio
async def test_a_child_mount_row_falls_back_to_directory_with_no_dispatcher():
    """Absence of the door can only mean "nobody can answer", so the row
    keeps the shape every caller outside a workspace already saw."""
    tree = {"/base": _dir("base")}
    readdir, stat = _make_fs_backend(tree)
    out, io = await ls([PathSpec.from_str_path("/base")],
                       readdir=readdir,
                       stat=stat,
                       classify=True,
                       child_mounts=lambda d: ["hist"] if d == "/base" else [])
    assert io.exit_code == 0
    assert out.decode() == "hist/\n"


@pytest.mark.asyncio
async def test_list_dir_itself_on_structure_only_directory():
    """-d stats the operand itself; the namespace fact is what says the
    directory exists, so the row must come from it when no backend
    does."""

    async def readdir(p, index=None):
        raise FileNotFoundError(p.virtual)

    async def stat(p, index=None):
        raise FileNotFoundError(p.virtual)

    def child_mounts(parent: str) -> list[str]:
        return ["deep"] if parent == "/ghost" else []

    out, io = await ls([PathSpec.from_str_path("/ghost")],
                       readdir=readdir,
                       stat=stat,
                       list_dir=True,
                       child_mounts=child_mounts)
    assert io.exit_code == 0
    assert out.decode() == "/ghost\n"


@pytest.mark.asyncio
async def test_link_operand_on_a_backend_whose_readdir_returns_empty():
    """Backends without real directories (s3, nextcloud) answer readdir
    on a link with an empty list rather than raising, which rendered the
    operand as an empty directory instead of the link's own row."""

    async def readdir(p, index=None):
        return []

    async def stat(p, index=None):
        raise FileNotFoundError(p.virtual)

    out, io = await ls([PathSpec.from_str_path("/data/symx/flink")],
                       readdir=readdir,
                       stat=stat,
                       long=True,
                       links=_link_view(_LINK_ROW))
    assert io.exit_code == 0
    assert out.decode().strip().endswith("flink -> /data/symx/real.txt")


# ── the flag set beyond -l: sort orders, columns, time styles ──────────

_VERSION_TREE = {
    "/v": _dir("v"),
    "/v/file10.txt": _file("file10.txt", 10),
    "/v/file2.txt": _file("file2.txt", 2),
    "/v/Z.txt": _file("Z.txt", 1),
    "/v/a.txt": _file("a.txt", 6),
    "/v/b.md": _file("b.md", 1),
    "/v/c": _file("c", 0),
    "/v/dir1": _dir("dir1"),
    "/v/dir2": _dir("dir2"),
}


async def _names(sort_by=LsSortBy.NAME, **kwargs) -> list[str]:
    readdir, stat = _make_fs_backend(_VERSION_TREE)
    output, _ = await ls([_spec("/v")],
                         readdir=readdir,
                         stat=stat,
                         sort_by=sort_by,
                         **kwargs)
    return output.decode().split()


@pytest.mark.asyncio
async def test_version_sort_reads_numbers_as_numbers():
    # Pinned on GNU coreutils 9.7: `ls -v`.
    assert await _names(LsSortBy.VERSION) == [
        "Z.txt", "a.txt", "b.md", "c", "dir1", "dir2", "file2.txt",
        "file10.txt"
    ]


@pytest.mark.asyncio
async def test_extension_sort_groups_by_suffix_then_name():
    # Pinned on GNU coreutils 9.7: `ls -X`; a name without a dot has the
    # empty suffix and sorts first.
    assert await _names(LsSortBy.EXTENSION) == [
        "c", "dir1", "dir2", "b.md", "Z.txt", "a.txt", "file10.txt",
        "file2.txt"
    ]


@pytest.mark.asyncio
async def test_group_directories_first_partitions_after_sorting():
    assert await _names(group_dirs_first=True) == [
        "dir1", "dir2", "Z.txt", "a.txt", "b.md", "c", "file10.txt",
        "file2.txt"
    ]
    assert await _names(group_dirs_first=True, reverse=True) == [
        "dir2", "dir1", "file2.txt", "file10.txt", "c", "b.md", "a.txt",
        "Z.txt"
    ]


def test_unsorted_keeps_the_listing_order_and_ignores_grouping():
    rows = [_file("b"), _dir("d"), _file("a")]
    assert [s.name for s in sort_stats(rows, LsSortBy.NONE, False)
            ] == ["b", "d", "a"]
    assert [
        s.name
        for s in sort_stats(rows, LsSortBy.NONE, False, group_dirs_first=True)
    ] == ["b", "d", "a"]
    # -r reverses while sorting, and -U does not sort (GNU: `ls -Ur`
    # lists exactly what `ls -U` lists).
    assert [s.name
            for s in sort_stats(rows, LsSortBy.NONE, True)] == ["b", "d", "a"]


def test_width_sort_orders_by_rendered_width_then_name():
    rows = [_file("ccc"), _file("b"), _file("aa"), _file("a")]
    assert [s.name for s in sort_stats(rows, LsSortBy.WIDTH, False)
            ] == ["a", "b", "aa", "ccc"]
    # Pinned on coreutils 9.7 under C.UTF-8: a wide character counts two
    # columns and a combining mark none.
    names = ["界", "aa", "é", "a", "e\u0301x"]
    rows = [_file(n) for n in names]
    assert [s.name for s in sort_stats(rows, LsSortBy.WIDTH, False)
            ] == ["a", "é", "aa", "e\u0301x", "界"]


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
        "/t":
        _dir("t"),
        "/t/old.txt":
        FileStat(name="old.txt",
                 size=1,
                 modified="2025-01-01T00:00:00Z",
                 atime="2025-06-01T00:00:00Z",
                 type=FileType.FILE),
        "/t/new.txt":
        FileStat(name="new.txt",
                 size=1,
                 modified="2025-03-01T00:00:00Z",
                 atime="2025-02-01T00:00:00Z",
                 type=FileType.FILE),
    }
    readdir, stat = _make_fs_backend(tree)
    output, _ = await ls([_spec("/t")],
                         readdir=readdir,
                         stat=stat,
                         sort_by=LsSortBy.TIME,
                         time_kind=LsTimeKind.ATIME)
    assert output.decode().split() == ["old.txt", "new.txt"]
    output, _ = await ls([_spec("/t")],
                         readdir=readdir,
                         stat=stat,
                         long=True,
                         columns=LsColumns(owner=False,
                                           group=False,
                                           time_kind=LsTimeKind.ATIME,
                                           time_style="long-iso"))
    assert output.decode().splitlines() == [
        "-rw-r--r-- 1 1 2025-02-01 00:00 new.txt",
        "-rw-r--r-- 1 1 2025-06-01 00:00 old.txt",
    ]


@pytest.mark.asyncio
async def test_long_columns_drop_owner_and_group_and_lead_with_question_marks(
):
    tree = {
        "/d": _dir("d"),
        "/d/a.txt": _file("a.txt", 42, "2025-01-15T10:30:00Z")
    }
    readdir, stat = _make_fs_backend(tree)
    output, _ = await ls([_spec("/d")],
                         readdir=readdir,
                         stat=stat,
                         long=True,
                         columns=LsColumns(owner=False,
                                           group=False,
                                           inode=True,
                                           context=True,
                                           time_style="long-iso"))
    assert output.decode() == "? -rw-r--r-- 1 ? 42 2025-01-15 10:30 a.txt\n"
    output, _ = await ls([_spec("/d")],
                         readdir=readdir,
                         stat=stat,
                         columns=LsColumns(inode=True, context=True))
    assert output.decode() == "? ? a.txt\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("style,expected", [
    ("full-iso", "2025-01-15 10:30:00.000000000 +0000"),
    ("long-iso", "2025-01-15 10:30"),
    ("iso", "2025-01-15 "),
    ("+%Y/%m/%d", "2025/01/15"),
    ("+%Y\n%H:%M", "2025"),
])
async def test_time_styles_spell_an_old_time_as_gnu_does(style, expected):
    tree = {
        "/d": _dir("d"),
        "/d/a.txt": _file("a.txt", 42, "2025-01-15T10:30:00Z")
    }
    readdir, stat = _make_fs_backend(tree)
    output, _ = await ls([_spec("/d")],
                         readdir=readdir,
                         stat=stat,
                         long=True,
                         columns=LsColumns(owner=False,
                                           group=False,
                                           time_style=style))
    assert output.decode() == f"-rw-r--r-- 1 42 {expected} a.txt\n"


@pytest.mark.asyncio
async def test_hyperlink_wraps_the_name_in_osc8():
    tree = {"/d": _dir("d"), "/d/a.txt": _file("a.txt", 1)}
    readdir, stat = _make_fs_backend(tree)
    output, _ = await ls([_spec("/d")],
                         readdir=readdir,
                         stat=stat,
                         hyperlink=True)
    assert output == b"\x1b]8;;file:///d/a.txt\x07a.txt\x1b]8;;\x07\n"


@pytest.mark.parametrize("flags,sort_by,time_kind", [
    ({
        "t": True,
        "S": True
    }, LsSortBy.SIZE, LsTimeKind.MTIME),
    ({
        "S": True,
        "sort": "version"
    }, LsSortBy.VERSION, LsTimeKind.MTIME),
    ({
        "u": True
    }, LsSortBy.TIME, LsTimeKind.ATIME),
    ({
        "u": True,
        "args_l": True
    }, LsSortBy.NAME, LsTimeKind.ATIME),
    ({
        "c": True,
        "u": True,
        "time": "status"
    }, LsSortBy.TIME, LsTimeKind.CTIME),
    ({
        "X": True,
        "U": True
    }, LsSortBy.NONE, LsTimeKind.MTIME),
])
def test_parse_flags_last_sort_and_time_spelling_win(flags, sort_by,
                                                     time_kind):
    parsed = parse_flags(flags)
    assert parsed.sort_by is sort_by
    assert parsed.time_kind is time_kind


def test_parse_flags_g_o_n_imply_long_and_shape_the_columns():
    parsed = parse_flags({"g": True, "o": True, "inode": True})
    assert parsed.long
    assert not parsed.columns.owner and not parsed.columns.group
    assert parsed.columns.inode
    assert parse_flags({"numeric_uid_gid": True}).long
    assert parse_flags({"g": True, "args_1": True}).long
    assert parse_flags({"args_l": True, "args_1": True}).long
    assert not parse_flags({"args_1": True}).long
    assert parse_flags({
        "block_size": "K"
    }).columns.block_size == BlockSize(1024, "K")
    with pytest.raises(UsageError, match="invalid --block-size argument '0K'"):
        parse_flags({"block_size": "0K"})
    # The later of -h and --block-size wins (dict order is typed order).
    assert parse_flags({
        "block_size": "K",
        "human_readable": True
    }).columns.block_size is None
    assert parse_flags({
        "human_readable": True,
        "block_size": "K"
    }).columns.block_size == BlockSize(1024, "K")
    with pytest.raises(UsageError):
        parse_flags({"block_size": "bogus", "human_readable": True})
    assert parse_flags({"hyperlink": "always"}).hyperlink
    assert not parse_flags({"hyperlink": "auto"}).hyperlink
    assert parse_flags({
        "time_style": "posix-long-iso"
    }).columns.time_style == "locale"


@pytest.mark.parametrize("flags,message,code", [
    ({
        "sort": "bogus"
    }, "ls: invalid argument 'bogus' for '--sort'\n"
     "Valid arguments are:\n  - 'none'\n  - 'time'\n  - 'size'\n"
     "  - 'extension'\n  - 'version'\n  - 'width'\n"
     "Try 'ls --help' for more information.", 1),
    ({
        "time": "bogus"
    }, "ls: invalid argument 'bogus' for '--time'\n"
     "Valid arguments are:\n  - 'atime', 'access', 'use'\n"
     "  - 'ctime', 'status'\n  - 'mtime', 'modification'\n"
     "  - 'birth', 'creation'\n"
     "Try 'ls --help' for more information.", 1),
    ({
        "time_style": "bogus"
    }, "ls: invalid argument 'bogus' for 'time style'\n"
     "Valid arguments are:\n  - [posix-]full-iso\n  - [posix-]long-iso\n"
     "  - [posix-]iso\n  - [posix-]locale\n"
     "  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n"
     "Try 'ls --help' for more information.", 2),
    ({
        "block_size": "bogus"
    }, "ls: invalid --block-size argument 'bogus'", 2),
    ({
        "hyperlink": "bogus"
    }, "ls: invalid argument 'bogus' for '--hyperlink'\n"
     "Valid arguments are:\n  - 'always', 'yes', 'force'\n"
     "  - 'never', 'no', 'none'\n  - 'auto', 'tty', 'if-tty'\n"
     "Try 'ls --help' for more information.", 1),
])
def test_parse_flags_refuses_in_gnu_words(flags, message, code):
    with pytest.raises(UsageError) as info:
        parse_flags(flags)
    assert str(info.value) == message
    assert info.value.exit_code == code


# ls's argument clauses name the refused word through gnulib's quote(), so
# a byte outside 0x20-0x7e comes back escaped rather than interpolated
# raw. Rows measured against GNU coreutils 9.4 under `LC_ALL=C` with a raw
# `bytes` argv (`ls --sort=<w>`, `--time=<w>`, `--hyperlink=<w>`,
# `-l --time-style=<w>`, and `--format=<w>`, which mirage has no option
# for but which renders through the same clause). Mirrored in ls.test.ts.
QUOTED_WORDS = [
    ("xé", r"x\303\251"),
    ("x\r", r"x\r"),
    ("x\x01", r"x\001"),
    ("x\x7f", r"x\177"),
    ("x'", r"x\'"),
    ("x\\", r"x\\"),
]


@pytest.mark.parametrize("value,escaped", QUOTED_WORDS)
@pytest.mark.parametrize("dest,option", [
    ("sort", "'--sort'"),
    ("time", "'--time'"),
    ("hyperlink", "'--hyperlink'"),
    ("time_style", "'time style'"),
])
def test_argument_clauses_quote_the_word(dest, option, value, escaped):
    with pytest.raises(UsageError) as info:
        parse_flags({dest: value})
    assert str(info.value).startswith(
        f"ls: invalid argument '{escaped}' for {option}\n")


@pytest.mark.parametrize("value", ["1é", "1\x01"])
def test_block_size_clause_stays_raw(value):
    """`--block-size` is quoted but NOT escaped, which is GNU's own split.

    Measured with `ls --block-size=1é`, which reports
    `invalid suffix in --block-size argument '1é'` with the two UTF-8
    bytes intact -- so this clause must not be routed through quote()
    even though its neighbours above are.
    """
    with pytest.raises(UsageError) as info:
        parse_flags({"block_size": value, "human_readable": True})
    assert value in str(info.value)


# GNU's own `sort_args`: `none time size extension version width`, in
# that order and with no `name`. Measured on coreutils 9.4
# (`ls --sort=name` is a refusal, not name order) -- an extra word mirage
# accepted was also a word missing from the list it printed back.
def test_sort_refuses_name_the_way_gnu_does():
    with pytest.raises(UsageError) as info:
        parse_flags({"sort": "name"})
    assert str(
        info.value).startswith("ls: invalid argument 'name' for '--sort'\n")
    assert info.value.exit_code == 1


# An EMPTY ARGMATCH value is `ambiguous`, not `invalid`: gnulib's argmatch
# matches on a prefix and `""` is a prefix of every candidate. Measured on
# coreutils 9.4: `ls --sort=`, `ls --time=`, `ls --hyperlink=` are exit 1
# and `ls -l --time-style=` is exit 2, ls's own `usage (LS_FAILURE)`.
@pytest.mark.parametrize("dest,option,code", [
    ("sort", "'--sort'", 1),
    ("time", "'--time'", 1),
    ("hyperlink", "'--hyperlink'", 1),
    ("time_style", "'time style'", 2),
])
def test_an_empty_argument_is_ambiguous(dest, option, code):
    with pytest.raises(UsageError) as info:
        parse_flags({dest: ""})
    assert str(
        info.value).startswith(f"ls: ambiguous argument '' for {option}\n")
    assert info.value.exit_code == code


# gnulib's argmatch resolves an unambiguous prefix and answers the
# canonical word of the value it matched. Every row measured on coreutils
# 9.4 (`ls --sort=non`, `-l --time=acc`, `--hyperlink=n`,
# `-l --time-style=full`).
@pytest.mark.parametrize("flags,attr,expected", [
    ({
        "sort": "non"
    }, "sort_by", LsSortBy.NONE),
    ({
        "sort": "n"
    }, "sort_by", LsSortBy.NONE),
    ({
        "sort": "si"
    }, "sort_by", LsSortBy.SIZE),
    ({
        "time": "a"
    }, "time_kind", LsTimeKind.ATIME),
    ({
        "time": "acc"
    }, "time_kind", LsTimeKind.ATIME),
    ({
        "time": "u"
    }, "time_kind", LsTimeKind.ATIME),
    ({
        "time": "m"
    }, "time_kind", LsTimeKind.MTIME),
    ({
        "time": "s"
    }, "time_kind", LsTimeKind.CTIME),
    ({
        "time": "b"
    }, "time_kind", LsTimeKind.BIRTH),
    ({
        "hyperlink": "al"
    }, "hyperlink", True),
    ({
        "hyperlink": "y"
    }, "hyperlink", True),
    ({
        "hyperlink": "f"
    }, "hyperlink", True),
    ({
        "hyperlink": "n"
    }, "hyperlink", False),
    ({
        "hyperlink": "au"
    }, "hyperlink", False),
    ({
        "hyperlink": "i"
    }, "hyperlink", False),
])
def test_parse_flags_accepts_an_unambiguous_prefix(flags, attr, expected):
    assert getattr(parse_flags(flags), attr) == expected


@pytest.mark.parametrize("value,expected", [
    ("full", "full-iso"),
    ("long", "long-iso"),
    ("i", "iso"),
    ("loc", "locale"),
    ("posix-full", "locale"),
])
def test_time_style_accepts_an_unambiguous_prefix(value, expected):
    assert parse_flags({"time_style": value}).columns.time_style == expected


# Ambiguity is decided on values: `--time=a` matches atime and access,
# one value, and is accepted above, while these span two and are refused.
@pytest.mark.parametrize("flags,message,code", [
    ({
        "time": "c"
    }, "ls: ambiguous argument 'c' for '--time'\n"
     "Valid arguments are:\n  - 'atime', 'access', 'use'\n"
     "  - 'ctime', 'status'\n  - 'mtime', 'modification'\n"
     "  - 'birth', 'creation'\n"
     "Try 'ls --help' for more information.", 1),
    ({
        "hyperlink": "a"
    }, "ls: ambiguous argument 'a' for '--hyperlink'\n"
     "Valid arguments are:\n  - 'always', 'yes', 'force'\n"
     "  - 'never', 'no', 'none'\n  - 'auto', 'tty', 'if-tty'\n"
     "Try 'ls --help' for more information.", 1),
    ({
        "time_style": "lo"
    }, "ls: ambiguous argument 'lo' for 'time style'\n"
     "Valid arguments are:\n  - [posix-]full-iso\n  - [posix-]long-iso\n"
     "  - [posix-]iso\n  - [posix-]locale\n"
     "  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n"
     "Try 'ls --help' for more information.", 2),
])
def test_parse_flags_refuses_a_prefix_spanning_two_values(
        flags, message, code):
    with pytest.raises(UsageError) as info:
        parse_flags(flags)
    assert str(info.value) == message
    assert info.value.exit_code == code


# `ls --sort=NON`, `=NONE` and `=None` are all `invalid argument`, never
# ambiguous and never accepted: gnulib compares bytes (measured).
@pytest.mark.parametrize("value", ["NON", "NONE", "None"])
def test_prefix_matching_is_case_sensitive(value):
    with pytest.raises(UsageError) as info:
        parse_flags({"sort": value})
    assert str(info.value).startswith(
        f"ls: invalid argument '{value}' for '--sort'\n")
    assert info.value.exit_code == 1


# The block and the hint are byte-identical between the two wordings;
# only the first line differs. Measured by stripping line 1 from
# `ls -l --time=c` and `-l --time=zzz`.
def test_the_ambiguous_and_invalid_blocks_are_the_same_below_line_one():
    with pytest.raises(UsageError) as ambiguous:
        parse_flags({"time": "c"})
    with pytest.raises(UsageError) as invalid:
        parse_flags({"time": "zzz"})
    assert str(ambiguous.value).split("\n", 1)[1] == (str(invalid.value).split(
        "\n", 1)[1])
    assert ambiguous.value.exit_code == invalid.value.exit_code == 1


# xstrtoumax's three refusals as ls words them, measured on coreutils 9.7;
# the word is quoted but never escaped. Mirrored in ls.test.ts.
@pytest.mark.parametrize("value,message", [
    ("x", "ls: invalid --block-size argument 'x'"),
    ("", "ls: invalid --block-size argument ''"),
    ("0K", "ls: invalid --block-size argument '0K'"),
    ("1x", "ls: invalid suffix in --block-size argument '1x'"),
    ("Kx", "ls: invalid suffix in --block-size argument 'Kx'"),
    ("1e", "ls: invalid suffix in --block-size argument '1e'"),
    ("1R", "ls: invalid suffix in --block-size argument '1R'"),
    ("Y", "ls: --block-size argument 'Y' too large"),
    ("16E", "ls: --block-size argument '16E' too large"),
])
def test_block_size_refusals_are_worded_as_gnu_words_them(value, message):
    with pytest.raises(UsageError) as exc:
        parse_flags({"block_size": value})
    assert str(exc.value) == message
    assert exc.value.exit_code == 2
