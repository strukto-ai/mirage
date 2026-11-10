from types import SimpleNamespace

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.builtin.generic.tree import (
    _HELD_LINES,
    TreeFlags,
    _segments_match,
    parse_flags,
    tree,
)
from mirage.commands.spec import SPECS
from mirage.io.stream import close_quietly
from mirage.io.types import IOResult, materialize
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.workspace.executor.command.flags import (
    parse_flags as parse_line_flags,
)


async def _tree(*args, **kwargs):
    output, io = await tree(*args, **kwargs)
    return await materialize(output), io


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
    output, _ = await _tree([_spec("/r")], readdir=readdir, stat=stat)
    decoded = output.decode()
    assert ".hidden" not in decoded
    assert "visible.txt" in decoded


@pytest.mark.asyncio
async def test_tree_empty_dir_reports_zero_counts():
    tree_map = {"/r": _dir("r")}
    readdir, stat = _make_backend(tree_map)
    output, io = await _tree([_spec("/r")], readdir=readdir, stat=stat)
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

    output, io = await _tree([_spec("/a.txt/x")], readdir=readdir, stat=stat)
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

    output, io = await _tree([_spec("/r")], readdir=readdir, stat=stat)
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
    output, io = await _tree(
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


async def _nothing_there(path):
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize("known", [True, False])
async def test_tree_prints_a_mount_roots_own_details(known):
    parent = {"/base": _dir("base"), "/base/inner": _dir("inner")}
    child = {"/base/inner": _dir("inner")}
    child["/base/inner"] = FileStat(
        name="",
        type=FileType.DIRECTORY,
        mode=0o40700,
        modified="2001-02-03T04:05:06Z",
    )
    readdir, stat = _make_backend(parent)
    readdir_path, stat_path = _dispatch_pair(parent, child, "/base/inner")

    async def without_root(path):
        virtual = path.virtual if isinstance(path, PathSpec) else path
        return None if virtual == "/base/inner" else await stat_path(path)

    output, _ = await _tree(
        [_spec("/base")],
        flags=TreeFlags(perms=True, no_report=True),
        readdir=readdir,
        stat=stat,
        mounts=_mounts_view(["/base/inner"]),
        readdir_path=readdir_path,
        stat_path=stat_path if known else without_root,
    )
    row = output.decode().splitlines()[-1]
    assert row.endswith("inner")
    assert ("drwx------" in row) is known


@pytest.mark.asyncio
async def test_tree_counts_no_bytes_for_a_missing_path():
    readdir, stat = _make_backend({})
    output, io = await _tree(
        [_spec("/gone")],
        flags=TreeFlags(du=True),
        readdir=readdir,
        stat=stat,
        stat_path=_nothing_there,
    )
    assert output.decode().splitlines()[-1].split()[0] == "0"
    assert io.exit_code == 2


@pytest.mark.asyncio
async def test_tree_json_writes_a_name_it_cannot_decode_as_its_bytes():
    name = "bad\udcff"
    readdir, stat = _make_backend({"/r": _dir("r"), f"/r/{name}": _file(name)})
    output, _ = await _tree(
        [_spec("/r")],
        flags=TreeFlags(json=True, no_report=True),
        readdir=readdir,
        stat=stat,
    )
    assert b'"name":"bad\xff"' in output


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
    output, io = await _tree(
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


@pytest.mark.asyncio
async def test_tree_sorts_by_status_change_where_a_backend_keeps_one():
    tree_map = {
        "/r": _dir("r"),
        "/r/a": FileStat(
            name="a",
            size=0,
            type=FileType.FILE,
            modified="2001-01-01T00:00:00Z",
            ctime="2003-01-01T00:00:00Z",
        ),
        "/r/b": FileStat(
            name="b",
            size=0,
            type=FileType.FILE,
            modified="2002-01-01T00:00:00Z",
        ),
    }
    readdir, stat = _make_backend(tree_map)
    orders = {}
    for sort in ("mtime", "ctime"):
        output, _ = await _tree(
            [_spec("/r")],
            flags=TreeFlags(sort=sort, no_report=True),
            readdir=readdir,
            stat=stat,
        )
        orders[sort] = output.decode().split()[-1]
    assert orders == {"mtime": "b", "ctime": "a"}


@pytest.mark.parametrize(
    "path,pattern,hit",
    [
        ("a/b", "a/b", True),
        ("a/b", "a/c", False),
        ("a", "a/**", False),
        ("a/b/c", "a/**", True),
        ("a/b/c", "**/c", True),
        ("c", "**/c", True),
        ("a/x/b/y/c", "a/**/b/**/c", True),
        ("a/b", "a/**/b/**/c", False),
        ("b/a", "a/**/b", False),
        ("a/b/x", "**/b", False),
        ("a/b", "**", True),
    ],
)
def test_ignore_paths_fit_their_patterns(path, pattern, hit):
    assert _segments_match(path.split("/"), pattern.split("/")) is hit


def test_many_globstars_over_a_deep_path_end():
    parts = ["a"] * 200
    pattern = ["**"] * 200 + ["absent"]
    assert not _segments_match(parts, pattern)


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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,opened",
    [
        (TreeFlags(), ["/r"]),
        (TreeFlags(json=True), ["/r", "/r/a", "/r/b"]),
    ],
)
async def test_tree_reads_no_further_than_its_reader_when_it_can(
    flags, opened
):
    tree_map = {
        "/r": _dir("r"),
        "/r/a": _dir("a"),
        "/r/a/x": _file("x"),
        "/r/b": _dir("b"),
    }
    readdir, stat = _make_backend(tree_map)
    seen: list[str] = []

    async def noting(p: PathSpec) -> list[str]:
        seen.append(p.virtual)
        return await readdir(p)

    output, _ = await tree(
        [_spec("/r")], readdir=noting, stat=stat, flags=flags
    )
    await anext(output)
    await close_quietly(output)
    assert seen == opened


@pytest.mark.asyncio
async def test_tree_writes_a_flat_directory_a_bounded_run_at_a_time():
    names = {f"/r/{n:04}": _file(f"{n:04}") for n in range(3000)}
    readdir, stat = _make_backend({"/r": _dir("r"), **names})
    output, _ = await tree([_spec("/r")], readdir=readdir, stat=stat)
    first = await anext(output)
    await close_quietly(output)
    assert first.count(b"\n") == _HELD_LINES


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stdout",
    [
        (
            "touch /d/a; tree -u -g --noreport /d",
            "[-        -       ]  /d\n`-- [-        -       ]  a\n",
        ),
        (
            "touch /d/a; tree --inodes --noreport /d",
            "[      ?]  /d\n`-- [      ?]  a\n",
        ),
        (
            "touch /d/a; tree -J -u -g --noreport /d",
            '[\n  {"type":"directory","name":"/d","user":"-","group":"-",'
            '"contents":[\n    {"type":"file","name":"a","user":"-",'
            '"group":"-"}\n  ]}\n\n]\n',
        ),
        (
            "truncate -s 9947 /d/a; tree --si --noreport -L 1 /d | tail -n 1",
            "`-- [9.9k]  a\n",
        ),
        (
            "truncate -s 9948 /d/a; tree --si --noreport -L 1 /d | tail -n 1",
            "`-- [ 10k]  a\n",
        ),
        (
            "truncate -s 10500 /d/a; tree --si --noreport -L 1 /d | tail -n 1",
            "`-- [ 10k]  a\n",
        ),
        (
            "truncate -s 1250 /d/a; tree --si --noreport -L 1 /d | tail -n 1",
            "`-- [1.2k]  a\n",
        ),
        (
            "truncate -s 999500 /d/a; tree --si --noreport -L 1 /d | "
            "tail -n 1",
            "`-- [1000k]  a\n",
        ),
        (
            "truncate -s 1000000 /d/a; tree --si --noreport -L 1 /d | "
            "tail -n 1",
            "`-- [1.0M]  a\n",
        ),
        (
            "touch '/d/x y'; LC_ALL=C.UTF-8 tree --noreport /d | tail -n 1",
            "└── x y\n",
        ),
    ],
)
async def test_tree_host_flags(line, stdout):
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(line)
    assert await io.stdout_str() == stdout
    assert await io.stderr_str() == ""


@pytest.mark.asyncio
async def test_tree_lx_stays_out_of_a_mount_below_a_link():
    ws = Workspace(
        {"/d": RAMVFS(), "/d/real/m": RAMVFS()}, mode=MountMode.WRITE
    )
    await ws.shell(
        "mkdir -p /d/root /d/real; printf x > /d/real/f; "
        "printf y > /d/real/m/g; ln -s ../real /d/root/a"
    )
    kept = await ws.shell("tree -lx --noreport /d/root")
    crossed = await ws.shell("tree -l --noreport /d/root")
    assert (
        await kept.stdout_str()
        == "/d/root\n`-- a -> ../real\n    |-- f\n    `-- m\n"
    )
    assert (
        await crossed.stdout_str()
        == "/d/root\n`-- a -> ../real\n    |-- f\n    `-- m\n        `-- g\n"
    )


@pytest.mark.asyncio
async def test_tree_l_keeps_a_hidden_mount_below_a_link_hidden():
    ws = Workspace(
        {"/d": RAMVFS(), "/d/real/m": RAMVFS()}, mode=MountMode.WRITE
    )
    await ws.shell(
        "mkdir -p /d/root /d/real; printf x > /d/real/f; "
        "printf y > /d/real/m/g; ln -s ../real /d/root/a"
    )
    ws.create_session("agent", profile={"paths": {"hide": ["/d/root/a/m"]}})
    io = await ws.shell("tree -lx --noreport /d/root", session_id="agent")
    assert await io.stdout_str() == "/d/root\n`-- a -> ../real\n    `-- f\n"


@pytest.mark.asyncio
async def test_tree_l_draws_no_mount_added_under_a_link_name():
    ws = Workspace({"/d": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell(
        "mkdir -p /d/root /d/real; printf x > /d/real/f; "
        "ln -s ../real /d/root/a"
    )
    ws.add_mount("/d/root/a/m", RAMVFS(), mode=MountMode.WRITE)
    io = await ws.shell("tree -l --noreport /d/root")
    assert await io.stdout_str() == "/d/root\n`-- a -> ../real\n    `-- f\n"
    assert io.exit_code == 0
