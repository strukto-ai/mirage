from datetime import datetime, timezone

import pytest

from mirage.commands.builtin.generic.ls import format_simple, ls, walk
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
    entries, warnings = await walk(_spec("/dir"), readdir=readdir, stat=stat)
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
    entries, _ = await walk(_spec("/dir"), readdir=readdir, stat=stat)
    assert [e.name for e in entries] == ["visible.txt"]
    entries, _ = await walk(_spec("/dir"),
                            readdir=readdir,
                            stat=stat,
                            all_files=True)
    assert sorted(e.name for e in entries) == [".hidden", "visible.txt"]


@pytest.mark.asyncio
async def test_walk_sort_by_size():
    tree = {
        "/dir": _dir("dir"),
        "/dir/big.txt": _file("big.txt", 1000),
        "/dir/small.txt": _file("small.txt", 1),
    }
    readdir, stat = _make_fs_backend(tree)
    entries, _ = await walk(_spec("/dir"),
                            readdir=readdir,
                            stat=stat,
                            sort_by=LsSortBy.SIZE)
    assert [e.name for e in entries] == ["big.txt", "small.txt"]
    entries, _ = await walk(_spec("/dir"),
                            readdir=readdir,
                            stat=stat,
                            sort_by=LsSortBy.SIZE,
                            reverse=True)
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
    entries, _ = await walk(_spec("/dir"),
                            readdir=readdir,
                            stat=stat,
                            sort_by=LsSortBy.TIME)
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
    entries, _ = await walk(_spec("/dir"),
                            readdir=readdir,
                            stat=stat,
                            recursive=True)
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
    entries, _ = await walk(_spec("/dir"),
                            readdir=readdir,
                            stat=stat,
                            list_dir=True)
    # GNU ls -d prints the operand as given.
    assert [e.name for e in entries] == ["/dir"]


@pytest.mark.asyncio
async def test_walk_missing_path_collects_warning():
    readdir, stat = _make_fs_backend({})
    entries, warnings = await walk(_spec("/nope"), readdir=readdir, stat=stat)
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
async def test_ls_missing_path_returns_warning_and_exit_1():
    readdir, stat = _make_fs_backend({})
    output, io = await ls([_spec("/nope")], readdir=readdir, stat=stat)
    assert output == b""
    assert io.exit_code == 1
    assert b"/nope" in (io.stderr or b"")


@pytest.mark.asyncio
async def test_walk_single_file_lists_itself():
    tree = {"/dir/a.parquet": _file("a.parquet", 5)}
    readdir, stat = _make_fs_backend(tree)
    entries, warnings = await walk(_spec("/dir/a.parquet"),
                                   readdir=readdir,
                                   stat=stat)
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

    entries, warnings = await walk(_spec("/data/a.parquet"),
                                   readdir=readdir,
                                   stat=stat)
    assert [e.name for e in entries] == ["/data/a.parquet"]
    assert warnings == []


@pytest.mark.asyncio
async def test_walk_empty_dir_stays_empty():
    tree = {"/empty": _dir("empty")}
    readdir, stat = _make_fs_backend(tree)
    entries, warnings = await walk(_spec("/empty"), readdir=readdir, stat=stat)
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
