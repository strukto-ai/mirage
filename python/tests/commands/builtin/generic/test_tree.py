from types import SimpleNamespace

import pytest

from mirage.commands.builtin.generic.tree import tree
from mirage.types import ContentType, FileStat, FileType, PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path, directory=path, vfs_path=path.strip("/"))


def _file(name: str, size: int = 0) -> FileStat:
    return FileStat(
        name=name, size=size, type=FileType.FILE, content=ContentType.TEXT
    )


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
                remainder = key[len(prefix) :]
                if "/" not in remainder:
                    children.append(key)
        return sorted(children)

    return readdir, stat


@pytest.mark.asyncio
async def test_tree_hides_dotfiles_by_default():
    tree_map = {
        "/r": _dir("r"),
        "/r/.hidden": _file(".hidden"),
        "/r/visible.txt": _file("visible.txt"),
    }
    readdir, stat = _make_backend(tree_map)
    output, _ = await tree([_spec("/r")], readdir=readdir, stat=stat)
    decoded = output.decode()
    assert ".hidden" not in decoded
    assert "visible.txt" in decoded


@pytest.mark.asyncio
async def test_tree_empty_dir_reports_zero_counts():
    tree_map = {"/r": _dir("r")}
    readdir, stat = _make_backend(tree_map)
    output, io = await tree([_spec("/r")], readdir=readdir, stat=stat)
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

    output, io = await tree([_spec("/a.txt/x")], readdir=readdir, stat=stat)
    lines = output.decode().splitlines()
    assert lines == [
        "/a.txt/x  [error opening dir]",
        "",
        "0 directories, 0 files",
    ]
    assert io.exit_code == 2


def _dispatch_pair(parent: dict, child: dict, root: str):
    """The dispatcher's view: each path answered by its OWNING mount.

    A key the parent holds under the mount root is shadowed and cannot be
    reached through it, which is the whole point of crossing.
    """
    parent_readdir, _ = _make_backend(parent)
    child_readdir, _ = _make_backend(child)

    def owner(virtual: str) -> tuple[dict, object]:
        under = virtual == root or virtual.startswith(root + "/")
        return (child, child_readdir) if under else (parent, parent_readdir)

    async def readdir_path(virtual: str) -> list[str]:
        _, readdir = owner(virtual)
        return await readdir(_spec(virtual))

    async def stat_path(virtual: str):
        rows, _ = owner(virtual)
        return rows.get(virtual)

    return readdir_path, stat_path


def _under(roots: list[str], path: str) -> list[str]:
    return [
        r
        for r in roots
        if r.startswith(path.rstrip("/") + "/") and r != path.rstrip("/")
    ]


def _mounts_view(roots: list[str]):
    return SimpleNamespace(
        descendants=lambda path: _under(roots, path),
        visible_descendants=lambda path: _under(roots, path),
        is_root=lambda path: path.rstrip("/") in roots,
        root_of=lambda path: "/",
    )


@pytest.mark.asyncio
async def test_tree_crosses_into_a_nested_mount():
    """Real ``tree`` draws the mounted filesystem's entries under the mount
    point, never the ones it covers, and counts the whole thing once
    (pinned on tree 2.2.1 over a tmpfs at the same spot). Concatenating a
    per-mount run cannot do that: it would print two roots and two
    summaries.
    """
    parent = {
        "/base": _dir("base"),
        "/base/top.txt": _file("top.txt"),
        "/base/inner": _dir("inner"),
        "/base/inner/leftover.txt": _file("leftover.txt"),
    }
    child = {
        "/base/inner": _dir("inner"),
        "/base/inner/real.txt": _file("real.txt"),
        "/base/inner/deep": _dir("deep"),
        "/base/inner/deep/d.txt": _file("d.txt"),
    }
    readdir, stat = _make_backend(parent)
    readdir_path, stat_path = _dispatch_pair(parent, child, "/base/inner")
    output, io = await tree(
        [_spec("/base")],
        readdir=readdir,
        stat=stat,
        mounts=_mounts_view(["/base/inner"]),
        readdir_path=readdir_path,
        stat_path=stat_path,
    )
    assert output.decode().splitlines() == [
        "/base",
        "|-- inner",
        "|   |-- deep",
        "|   |   `-- d.txt",
        "|   `-- real.txt",
        "`-- top.txt",
        "",
        "3 directories, 3 files",
    ]
    assert io.exit_code == 0
