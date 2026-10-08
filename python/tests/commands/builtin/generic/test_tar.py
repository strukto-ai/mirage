import io
import tarfile

import pytest

from mirage.commands.builtin.generic.archive.types import Walked
from mirage.commands.builtin.generic.tar import (
    excluded,
    member_name,
    pruned,
    strip_prefix,
    tar,
)
from mirage.doors.types import LinkView, MountView
from mirage.types import (
    LINK_TARGET_KEY,
    ContentType,
    FileStat,
    FileType,
    PathSpec,
)
from mirage.utils.key_prefix import mount_key


def _spec(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path,
        resolved=True,
    )


def _raw(path: str, raw: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path,
        resolved=True,
        raw_path=raw,
    )


class _Tree:
    """A tiny in-memory backend: files by path, directories derived."""

    def __init__(self, files: dict[str, bytes], dirs: tuple[str, ...] = ()):
        self.files = dict(files)
        self.dirs = set(dirs)
        for path in files:
            parent = path.rsplit("/", 1)[0]
            while parent:
                self.dirs.add(parent)
                parent = parent.rsplit("/", 1)[0] if "/" in parent else ""

    async def read_bytes(self, path):
        key = path.virtual if isinstance(path, PathSpec) else path
        if key in getattr(self, "refused", ()):
            raise PermissionError(13, "frozen", key)
        if key not in self.files:
            raise FileNotFoundError(key)
        return self.files[key]

    async def write_bytes(self, path, data):
        self.files[path.virtual] = data

    async def mkdir(self, path, parents=False):
        self.dirs.add(path.virtual.rstrip("/"))

    async def stat(self, path):
        key = path.virtual.rstrip("/") or "/"
        if key in self.dirs:
            return FileStat(name=key, type=FileType.DIRECTORY)
        if key in self.files:
            return FileStat(
                name=key,
                type=FileType.FILE,
                content=ContentType.TEXT,
                size=len(self.files[key]),
            )
        raise FileNotFoundError(key)

    async def walk(self, path, find_type):
        base = path.virtual.rstrip("/") or "/"
        pool = self.dirs if find_type == "d" else self.files
        closed = getattr(self, "closed", ())
        return Walked(
            paths=tuple(
                sorted(
                    p
                    for p in pool
                    if (p == base or p.startswith(base.rstrip("/") + "/"))
                    and not any(p.startswith(c + "/") for c in closed)
                )
            ),
            unreadable=tuple(
                c for c in closed if c.startswith(base.rstrip("/") + "/")
            ),
        )

    async def is_dir(self, path):
        return (path.virtual.rstrip("/") or "/") in self.dirs


def _links(entries: dict[str, str]) -> LinkView:
    def stat_of(path):
        target = entries[path]
        return FileStat(
            name=path,
            type=FileType.SYMLINK,
            size=len(target),
            extra={LINK_TARGET_KEY: target},
        )

    async def target_stat(path):
        return None

    async def exists(path):
        return path in entries

    return LinkView(
        stat_at=lambda p: stat_of(p) if p in entries else None,
        children=lambda p: [],
        subtree=lambda p: [
            (k, stat_of(k))
            for k in sorted(entries)
            if k.startswith(p.rstrip("/") + "/")
        ],
        resolve=lambda p: entries.get(p, p),
        exists=exists,
        target_stat=target_stat,
    )


def _mounts(
    descendants: tuple[str, ...] = (), roots: tuple[str, ...] = ()
) -> MountView:
    def root_of(path):
        for root in sorted(roots, key=len, reverse=True):
            if path == root or path.startswith(root.rstrip("/") + "/"):
                return root
        return "/"

    return MountView(
        descendants=lambda p: [
            d for d in descendants if d.startswith(p.rstrip("/") + "/")
        ],
        visible_descendants=lambda p: [
            d for d in descendants if d.startswith(p.rstrip("/") + "/")
        ],
        is_root=lambda p: p.rstrip("/") in {r.rstrip("/") for r in roots},
        root_of=root_of,
    )


async def _create(tree: _Tree, paths, **flags):
    return await tar(
        paths,
        read_bytes=tree.read_bytes,
        write_bytes=tree.write_bytes,
        mkdir_fn=tree.mkdir,
        stat=tree.stat,
        walk=tree.walk,
        is_dir=tree.is_dir,
        **flags,
    )


def _names(archive: bytes) -> list[str]:
    with tarfile.open(fileobj=io.BytesIO(archive)) as tf:
        return [
            member.name + "/" if member.isdir() else member.name
            for member in tf.getmembers()
        ]


def test_excluded_matches_whole_name_and_every_component_suffix():
    assert excluded("d/sub/b.txt", "sub/b.txt")
    # The pattern is anchored at a component boundary, not mid-name.
    assert not excluded("d/abc.txt", "bc.txt")


def test_pruned_takes_the_children_of_an_excluded_directory():
    names = ["d/", "d/a.txt", "d/sub/", "d/sub/b.txt"]
    assert pruned(names, "sub") == ["d/", "d/a.txt"]
    assert pruned(names, "sub/b.txt") == ["d/", "d/a.txt", "d/sub/"]
    assert pruned(names, None) == names


@pytest.mark.parametrize(
    "path,kind,name",
    [
        ("/data/d", "dir", "data/d/"),
        ("sub/..", "dir", "./"),
    ],
)
def test_member_name_strips_the_leading_slash_and_marks_directories(
    path: str, kind: str, name: str
):
    assert member_name(path, kind) == name


# Every row is GNU tar 1.35 on debian:stable-slim: `tar -cf` for the
# notice, `tar -tf` for the stored name.
STRIP_PREFIX_ROWS = [
    ("x/../y/f3", "y/f3", "x/../"),
    # A `.` climbs nowhere, so GNU stores it and says nothing.
    ("./file", "./file", ""),
    # Nothing survives the traversal; `member_name` supplies the name.
    ("sub/..", "", "sub/.."),
]


@pytest.mark.parametrize("spelled,name,prefix", STRIP_PREFIX_ROWS)
def test_strip_prefix_drops_through_the_last_dotdot(
    spelled: str, name: str, prefix: str
):
    assert strip_prefix(spelled) == (name, prefix)


@pytest.mark.asyncio
async def test_create_announces_a_prefix_and_archives_what_it_could_read():
    tree = _Tree({"/base/file": b"x"}, dirs=("/base", "/base/sub"))
    _, io_res = await _create(
        tree,
        [_raw("/base/file", "../file"), _raw("/base/nope", "nope")],
        c=True,
        f=_spec("/out.tar"),
    )
    assert io_res.exit_code == 2
    err = io_res.stderr.decode().splitlines()
    assert err[:2] == [
        "tar: Removing leading `../' from member names",
        "tar: nope: Cannot stat: No such file or directory",
    ]
    assert err[-1] == "tar: Exiting with failure status due to previous errors"
    assert _names(io_res.writes["/out.tar"]) == ["file"]


@pytest.mark.asyncio
async def test_create_stores_a_symlink_as_a_symlink():
    """The router must not dereference an operand before the planner sees
    it, and a walk must not dereference what it meets.
    """
    tree = _Tree({"/d/a.txt": b"a"}, dirs=("/d",))
    links = _links({"/d/link.txt": "a.txt", "/link": "/d/a.txt"})
    _, io_res = await _create(
        tree,
        [_raw("/d", "d"), _raw("/link", "link")],
        c=True,
        f=_spec("/out.tar"),
        links=links,
    )
    with tarfile.open(fileobj=io.BytesIO(io_res.writes["/out.tar"])) as tf:
        stored = {
            m.name: (m.size, m.linkname) for m in tf.getmembers() if m.issym()
        }
    assert stored == {"d/link.txt": (0, "a.txt"), "link": (0, "/d/a.txt")}


@pytest.mark.asyncio
async def test_dereference_reports_a_dangling_link_and_exits_two():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d",))
    links = _links({"/d/bad": "/d/nope"})
    _, io_res = await _create(
        tree,
        [_raw("/d", "d")],
        c=True,
        h=True,
        f=_spec("/out.tar"),
        links=links,
    )
    assert io_res.exit_code == 2
    assert "tar: d/bad: Cannot stat" in io_res.stderr.decode()


@pytest.mark.asyncio
async def test_create_stops_at_a_nested_mount_and_says_so():
    tree = _Tree({"/d/a.txt": b"a"}, dirs=("/d", "/d/nested"))
    mounts = _mounts(descendants=("/d/nested",), roots=("/", "/d/nested"))
    _, io_res = await _create(
        tree, [_raw("/d", "d")], c=True, f=_spec("/out.tar"), mounts=mounts
    )
    assert io_res.exit_code == 0
    assert (
        "tar: d/nested/: file is on a different filesystem; not dumped"
        in io_res.stderr.decode()
    )
    # The mountpoint stays an entry; only its contents are left out.
    assert _names(io_res.writes["/out.tar"]) == ["d/", "d/a.txt", "d/nested/"]


@pytest.mark.asyncio
async def test_an_empty_directory_round_trips_as_its_own_member():
    tree = _Tree({"/d/a.txt": b"x"}, dirs=("/d", "/d/empty", "/out"))
    _, io_res = await _create(
        tree, [_raw("/d", "d")], c=True, f=_spec("/out.tar")
    )
    assert "d/empty/" in _names(io_res.writes["/out.tar"])
    tree.files["/out.tar"] = io_res.writes["/out.tar"]
    _, io_res = await _create(
        tree, [], x=True, f=_spec("/out.tar"), C=[_spec("/out")]
    )
    assert any("d/a.txt" in path for path in io_res.writes)
    assert "/out/d/empty" in tree.dirs


@pytest.mark.asyncio
async def test_create_reports_what_it_may_not_open_and_exits_two():
    # Pinned on GNU tar 1.35 (debian:stable-slim) over a mode-000 file
    # and directory: "Cannot open: Permission denied" for each, named as
    # the operand was typed, the directory's own entry kept, the file
    # left out, one trailer, exit 2. The scan's directory comes before
    # the write's file, a deliberate ordering: GNU interleaves them in
    # readdir order.
    tree = _Tree(
        {"/d/a.txt": b"x", "/d/locked/y": b"y", "/d/sealed/s": b"s"},
        dirs=("/d", "/d/locked", "/d/sealed"),
    )
    tree.closed = ("/d/sealed",)
    tree.refused = ("/d/locked/y",)
    _, io_res = await _create(
        tree, [_raw("/d", "/d")], c=True, f=_spec("/out.tar")
    )
    assert io_res.exit_code == 2
    assert io_res.stderr.decode() == (
        "tar: Removing leading `/' from member names\n"
        "tar: /d/sealed: Cannot open: Permission denied\n"
        "tar: /d/locked/y: Cannot open: Permission denied\n"
        "tar: Exiting with failure status due to previous errors\n"
    )
    assert _names(io_res.writes["/out.tar"]) == [
        "d/",
        "d/a.txt",
        "d/locked/",
        "d/sealed/",
    ]
