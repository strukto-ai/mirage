from types import SimpleNamespace

import pytest

from mirage.commands.builtin.generic.tree import (
    TreeFlags,
    parse_flags,
    tree,
)
from mirage.commands.spec import SPECS
from mirage.io.types import IOResult
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.workspace.executor.command.flags import (
    parse_flags as parse_line_flags,
)


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


@pytest.mark.asyncio
async def test_tree_root_whose_entries_all_fail_to_stat_is_drawn_plainly():
    """tree 2.2.1 on a readable directory without search permission
    lists its names, stats none, and draws the root plainly with exit 0;
    only a root it cannot open is marked.
    """

    async def readdir(p: PathSpec, _index=None) -> list[str]:
        return ["/r/x", "/r/y"]

    async def stat(p: PathSpec, index=None) -> FileStat:
        raise PermissionError(p.virtual)

    output, io = await tree([_spec("/r")], readdir=readdir, stat=stat)
    assert output.decode().splitlines() == ["/r", "", "0 directories, 0 files"]
    assert io.exit_code == 0


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

    async def stat_path(path: str | PathSpec):
        virtual = path.virtual if isinstance(path, PathSpec) else path
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
        walk_limit=lambda path: -1,
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


_SIZED = {
    "/r": _dir("r"),
    "/r/a.txt": _file("a.txt", 6),
    "/r/b": _dir("b"),
    "/r/b/z10": _file("z10", 6),
    "/r/b/z9": _file("z9", 1),
    "/r/empty": _dir("empty"),
    "/r/.gitignore": _file(".gitignore", 6),
    "/r/x.log": _file("x.log", 3),
}


async def _read_gitignore(path: PathSpec):
    assert path.virtual == "/r/.gitignore"
    yield b"*.log\n"


@pytest.mark.parametrize(
    "flags,expected",
    [
        (
            TreeFlags(du=True, sizes=True),
            "[      12304]  /r\n|-- [          6]  a.txt\n"
            "|-- [       4103]  b\n|   |-- [          6]  z10\n"
            "|   `-- [          1]  z9\n|-- [       4096]  empty\n"
            "`-- [          3]  x.log\n\n"
            "       12304 bytes used in 3 directories, 4 files\n",
        ),
        (
            TreeFlags(
                gitignore=True, prune=True, dirs_first=True, sort="size"
            ),
            "/r\n|-- b\n|   |-- z10\n|   `-- z9\n`-- a.txt\n\n"
            "2 directories, 3 files\n",
        ),
        (
            TreeFlags(json=True, full_path=True, file_limit=1),
            '[\n  {"type":"directory","name":"/r","contents":[{"error": '
            '"4 entries exceeds filelimit, not opening dir"}\n  ]}\n,\n'
            '  {"type":"report","directories":1,"files":0}\n]\n',
        ),
        (
            TreeFlags(json=True, no_indent=True, no_report=True, max_depth=1),
            '[{"type":"directory","name":"/r","contents":[{"type":"file",'
            '"name":"a.txt"},{"type":"directory","name":"b"},{"type":'
            '"directory","name":"empty"},{"type":"file","name":"x.log"}]}]\n',
        ),
    ],
)
@pytest.mark.asyncio
async def test_tree_lays_out_sizes_orders_and_json(
    flags: TreeFlags, expected: str
):
    readdir, stat = _make_backend(_SIZED)
    output, io = await tree(
        [_spec("/r")],
        readdir=readdir,
        stat=stat,
        flags=flags,
        read=_read_gitignore,
    )
    assert (output.decode(), io.exit_code) == (expected, 0)


def _line_flags(argv: list[str]) -> TreeFlags | IOResult:
    parsed = parse_line_flags(argv, SPECS["tree"], "tree", "/")
    return parse_flags(parsed.flag_kwargs)


@pytest.mark.parametrize(
    "argv,sort,limit",
    [
        ([], "name", None),
        (["-t", "--sort=size"], "size", None),
        (["--sort=size", "-U"], "none", None),
        (["-v", "--filelimit", "3"], "version", 3),
        (["--filelimit=0"], "name", None),
    ],
)
def test_tree_order_is_the_last_one_typed(
    argv: list[str], sort: str, limit: int | None
):
    parsed = _line_flags(argv)
    assert isinstance(parsed, TreeFlags)
    assert (parsed.sort, parsed.file_limit) == (sort, limit)


def test_tree_names_the_orders_when_one_is_unknown():
    parsed = _line_flags(["--sort=n"])
    assert isinstance(parsed, IOResult)
    assert (parsed.exit_code, parsed.stdout, parsed.stderr) == (
        1,
        b"name,version,size,mtime,ctime,none\n",
        b"tree: Sort type 'n' not valid, should be one of: ",
    )
