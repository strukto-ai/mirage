import pytest

from mirage.commands.builtin.generic.tree import tree
from mirage.types import FileStat, FileType, PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path)


def _file(name: str, size: int = 0) -> FileStat:
    return FileStat(name=name, size=size, type=FileType.TEXT)


def _dir(name: str) -> FileStat:
    return FileStat(name=name, size=None, type=FileType.DIRECTORY)


def _make_backend(tree_map: dict[str, FileStat]):

    async def stat(p: PathSpec, index=None) -> FileStat:
        if p.original not in tree_map:
            raise FileNotFoundError(p.original)
        return tree_map[p.original]

    async def readdir(p: PathSpec, _index=None) -> list[str]:
        if p.original not in tree_map:
            raise FileNotFoundError(p.original)
        if tree_map[p.original].type != FileType.DIRECTORY:
            raise ValueError(f"not a directory: {p.original}")
        prefix = p.original.rstrip("/") + "/"
        children: list[str] = []
        for key in tree_map:
            if key == p.original:
                continue
            if key.startswith(prefix):
                remainder = key[len(prefix):]
                if "/" not in remainder:
                    children.append(key)
        return sorted(children)

    return readdir, stat


@pytest.mark.asyncio
async def test_tree_flat_dir():
    """Two siblings: the last gets `└──`, the others get `├──`."""
    tree_map = {
        "/r": _dir("r"),
        "/r/a.txt": _file("a.txt"),
        "/r/b.txt": _file("b.txt"),
    }
    readdir, stat = _make_backend(tree_map)
    output, io = await tree(_spec("/r"), readdir=readdir, stat=stat)
    lines = output.decode().splitlines()
    assert lines == ["├── a.txt", "└── b.txt"]
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_tree_nested_dir_uses_vertical_continuation():
    """A non-last directory should continue its children with `│   `."""
    tree_map = {
        "/r": _dir("r"),
        "/r/d1": _dir("d1"),
        "/r/d1/x.txt": _file("x.txt"),
        "/r/z.txt": _file("z.txt"),
    }
    readdir, stat = _make_backend(tree_map)
    output, _ = await tree(_spec("/r"), readdir=readdir, stat=stat)
    lines = output.decode().splitlines()
    assert lines == ["├── d1", "│   └── x.txt", "└── z.txt"]


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
    assert lines == ["└── d1", "    └── x.txt"]


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
    assert "d2" in decoded
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
async def test_tree_missing_path_emits_warning_not_crash():
    readdir, stat = _make_backend({})
    output, io = await tree(_spec("/nowhere"), readdir=readdir, stat=stat)
    assert output == b""
    assert b"nowhere" in (io.stderr or b"")


@pytest.mark.asyncio
async def test_tree_empty_dir_emits_nothing():
    tree_map = {"/r": _dir("r")}
    readdir, stat = _make_backend(tree_map)
    output, io = await tree(_spec("/r"), readdir=readdir, stat=stat)
    assert output == b""
    assert io.exit_code == 0
