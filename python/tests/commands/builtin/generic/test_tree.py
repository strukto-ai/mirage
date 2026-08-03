import pytest

from mirage.commands.builtin.generic.tree import tree
from mirage.types import FileStat, FileType, PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


def _file(name: str, size: int = 0) -> FileStat:
    return FileStat(name=name, size=size, type=FileType.TEXT)


def _dir(name: str) -> FileStat:
    return FileStat(name=name, size=None, type=FileType.DIRECTORY)


def _make_backend(tree_map: dict[str, FileStat]):

    async def stat(p: PathSpec, index=None) -> FileStat:
        if p.virtual not in tree_map:
            raise FileNotFoundError(p.virtual)
        return tree_map[p.virtual]

    async def readdir(p: PathSpec, _index=None) -> list[str]:
        if p.virtual not in tree_map:
            raise FileNotFoundError(p.virtual)
        if tree_map[p.virtual].type != FileType.DIRECTORY:
            raise ValueError(f"not a directory: {p.virtual}")
        prefix = p.virtual.rstrip("/") + "/"
        children: list[str] = []
        for key in tree_map:
            if key == p.virtual:
                continue
            if key.startswith(prefix):
                remainder = key[len(prefix):]
                if "/" not in remainder:
                    children.append(key)
        return sorted(children)

    return readdir, stat


@pytest.mark.asyncio
async def test_tree_flat_dir():
    """Two siblings: the last gets ``-- ``, the others get ``|-- ``."""
    tree_map = {
        "/r": _dir("r"),
        "/r/a.txt": _file("a.txt"),
        "/r/b.txt": _file("b.txt"),
    }
    readdir, stat = _make_backend(tree_map)
    output, io = await tree(_spec("/r"), readdir=readdir, stat=stat)
    lines = output.decode().splitlines()
    assert lines == [
        "/r", "|-- a.txt", "`-- b.txt", "", "1 directory, 2 files"
    ]
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_tree_nested_dir_uses_vertical_continuation():
    """A non-last directory should continue its children with ``|   ``."""
    tree_map = {
        "/r": _dir("r"),
        "/r/d1": _dir("d1"),
        "/r/d1/x.txt": _file("x.txt"),
        "/r/z.txt": _file("z.txt"),
    }
    readdir, stat = _make_backend(tree_map)
    output, _ = await tree(_spec("/r"), readdir=readdir, stat=stat)
    lines = output.decode().splitlines()
    assert lines == [
        "/r", "|-- d1", "|   `-- x.txt", "`-- z.txt", "",
        "2 directories, 2 files"
    ]


@pytest.mark.asyncio
async def test_tree_last_dir_uses_indent_continuation():
    """A last directory should continue with plain spaces, no vertical bar."""
    tree_map = {
        "/r": _dir("r"),
        "/r/d1": _dir("d1"),
        "/r/d1/x.txt": _file("x.txt"),
    }
    readdir, stat = _make_backend(tree_map)
    output, _ = await tree(_spec("/r"), readdir=readdir, stat=stat)
    lines = output.decode().splitlines()
    assert lines == [
        "/r", "`-- d1", "    `-- x.txt", "", "2 directories, 1 file"
    ]


@pytest.mark.asyncio
async def test_tree_max_depth_limits_recursion():
    tree_map = {
        "/r": _dir("r"),
        "/r/d1": _dir("d1"),
        "/r/d1/d2": _dir("d2"),
        "/r/d1/d2/deep.txt": _file("deep.txt"),
    }
    readdir, stat = _make_backend(tree_map)
    output, _ = await tree(_spec("/r"),
                           readdir=readdir,
                           stat=stat,
                           max_depth=1)
    decoded = output.decode()
    assert "d1" in decoded
    assert "d2" not in decoded
    assert "deep.txt" not in decoded


@pytest.mark.asyncio
async def test_tree_hides_dotfiles_by_default():
    tree_map = {
        "/r": _dir("r"),
        "/r/.hidden": _file(".hidden"),
        "/r/visible.txt": _file("visible.txt"),
    }
    readdir, stat = _make_backend(tree_map)
    output, _ = await tree(_spec("/r"), readdir=readdir, stat=stat)
    decoded = output.decode()
    assert ".hidden" not in decoded
    assert "visible.txt" in decoded


@pytest.mark.asyncio
async def test_tree_show_hidden_includes_dotfiles():
    tree_map = {
        "/r": _dir("r"),
        "/r/.hidden": _file(".hidden"),
        "/r/visible.txt": _file("visible.txt"),
    }
    readdir, stat = _make_backend(tree_map)
    output, _ = await tree(_spec("/r"),
                           readdir=readdir,
                           stat=stat,
                           show_hidden=True)
    assert ".hidden" in output.decode()


@pytest.mark.asyncio
async def test_tree_ignore_pattern_drops_matches():
    tree_map = {
        "/r": _dir("r"),
        "/r/a.pyc": _file("a.pyc"),
        "/r/b.py": _file("b.py"),
    }
    readdir, stat = _make_backend(tree_map)
    output, _ = await tree(_spec("/r"),
                           readdir=readdir,
                           stat=stat,
                           ignore_pattern="*.pyc")
    decoded = output.decode()
    assert "a.pyc" not in decoded
    assert "b.py" in decoded


@pytest.mark.asyncio
async def test_tree_dirs_only_drops_files():
    tree_map = {
        "/r": _dir("r"),
        "/r/d1": _dir("d1"),
        "/r/a.txt": _file("a.txt"),
    }
    readdir, stat = _make_backend(tree_map)
    output, _ = await tree(_spec("/r"),
                           readdir=readdir,
                           stat=stat,
                           dirs_only=True)
    decoded = output.decode()
    assert "d1" in decoded
    assert "a.txt" not in decoded


@pytest.mark.asyncio
async def test_tree_match_pattern_only_applies_to_files():
    """`-P` filters file names but never excludes directories."""
    tree_map = {
        "/r": _dir("r"),
        "/r/d1": _dir("d1"),
        "/r/d1/match.py": _file("match.py"),
        "/r/d1/skip.txt": _file("skip.txt"),
        "/r/top.py": _file("top.py"),
    }
    readdir, stat = _make_backend(tree_map)
    output, _ = await tree(_spec("/r"),
                           readdir=readdir,
                           stat=stat,
                           match_pattern="*.py")
    decoded = output.decode()
    assert "d1" in decoded
    assert "match.py" in decoded
    assert "skip.txt" not in decoded
    assert "top.py" in decoded


@pytest.mark.asyncio
async def test_tree_missing_path_marks_error_and_exits_2():
    readdir, stat = _make_backend({})
    output, io = await tree(_spec("/nowhere"), readdir=readdir, stat=stat)
    lines = output.decode().splitlines()
    assert lines == [
        "/nowhere  [error opening dir]", "", "0 directories, 0 files"
    ]
    assert io.exit_code == 2
    # GNU signals this with the inline marker and exit 2 and writes nothing to
    # stderr; TypeScript already behaved this way.
    assert io.stderr is None


@pytest.mark.asyncio
async def test_tree_empty_dir_reports_zero_counts():
    tree_map = {"/r": _dir("r")}
    readdir, stat = _make_backend(tree_map)
    output, io = await tree(_spec("/r"), readdir=readdir, stat=stat)
    assert output.decode().splitlines() == ["/r", "", "0 directories, 0 files"]
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_tree_not_a_directory_matches_the_missing_path_shape():
    """GNU `tree /a.txt/x` prints the same `[error opening dir]` body and
    exits 2 as `tree /nope`; ENOTDIR must not escape the walk.
    """

    async def readdir(p: PathSpec, _index=None) -> list[str]:
        raise NotADirectoryError(p.virtual)

    async def stat(p: PathSpec, index=None) -> FileStat:
        raise NotADirectoryError(p.virtual)

    output, io = await tree(_spec("/a.txt/x"), readdir=readdir, stat=stat)
    lines = output.decode().splitlines()
    assert lines == [
        "/a.txt/x  [error opening dir]", "", "0 directories, 0 files"
    ]
    assert io.exit_code == 2


def _stat_path(stat: FileStat | None):

    async def fn(_virtual: str) -> FileStat | None:
        return stat

    return fn


async def _unreached_readdir(*_a, **_kw) -> list[str]:
    raise AssertionError("a non-directory operand must not be listed")


async def _unreached_stat(*_a, **_kw) -> FileStat:
    raise AssertionError("a non-directory operand must not be listed")


# GNU tree 2.2.1, pinned on debian:stable-slim. A file operand gets the
# same inline marker an unopenable one does, but it exists, so it is
# counted and the exit status stays 0:
#   tree <file>     -> "<file>  [error opening dir]", 0 directories, 1 file, 0
#   tree -d <file>  -> same marker, "0 directories", exit 0
#   tree <missing>  -> same marker, 0 directories, 0 files, exit 2


@pytest.mark.asyncio
async def test_tree_file_operand_is_counted_and_exits_zero():
    output, io = await tree(
        _spec("/r/a.txt"),
        readdir=_unreached_readdir,
        stat=_unreached_stat,
        stat_path=_stat_path(_file("a.txt", 6)),
    )
    assert io.exit_code == 0
    assert output == (b"/r/a.txt  [error opening dir]\n\n"
                      b"0 directories, 1 file\n")


@pytest.mark.asyncio
async def test_tree_file_operand_dirs_only_omits_the_file_count():
    output, io = await tree(
        _spec("/r/a.txt"),
        readdir=_unreached_readdir,
        stat=_unreached_stat,
        dirs_only=True,
        stat_path=_stat_path(_file("a.txt", 6)),
    )
    assert io.exit_code == 0
    assert output == b"/r/a.txt  [error opening dir]\n\n0 directories\n"


@pytest.mark.asyncio
async def test_tree_unstattable_operand_still_walks():
    """A stat that sees nothing is not proof of absence.

    A backend with implicit directories has no inode for a key prefix, so
    the walk decides: it already renders an unopenable root as the inline
    marker with exit 2.
    """

    async def readdir(_p: PathSpec, _index=None) -> list[str]:
        raise FileNotFoundError("/r/nope")

    output, io = await tree(
        _spec("/r/nope"),
        readdir=readdir,
        stat=_unreached_stat,
        stat_path=_stat_path(None),
    )
    assert io.exit_code == 2
    assert output == (b"/r/nope  [error opening dir]\n\n"
                      b"0 directories, 0 files\n")
