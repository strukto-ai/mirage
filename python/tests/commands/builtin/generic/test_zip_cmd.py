import io
import zipfile

import pytest

from mirage.commands.builtin.generic.archive.types import Walked
from mirage.commands.builtin.generic.zip_cmd import (
    excluded,
    member_name,
    zip_cmd,
)
from mirage.ops.types import LinkView, MountView
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
        if key not in self.files:
            raise FileNotFoundError(key)
        return self.files[key]

    async def write_bytes(self, path, data):
        self.files[path.virtual] = data

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


async def _zip(tree: _Tree, paths, **flags):
    return await zip_cmd(
        paths,
        read_bytes=tree.read_bytes,
        write_bytes=tree.write_bytes,
        stat=tree.stat,
        walk=tree.walk,
        **flags,
    )


def _entries(archive: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        return [info.filename for info in zf.infolist()]


# Pinned against Info-ZIP 3.0 on debian:stable-slim.
@pytest.mark.parametrize(
    "path,kind,junk,name",
    [
        ("/d/a.txt", "file", False, "d/a.txt"),
        ("././sub", "dir", False, "sub/"),
        (".//sub", "dir", False, "/sub/"),
        ("./sub/b.txt", "file", True, "b.txt"),
    ],
)
def test_member_name_strips_the_leading_slash_and_dot_slash_run(
    path, kind, junk, name
):
    assert member_name(path, kind, junk) == name


# Info-ZIP matches the whole stored name, so a bare component misses, and
# it strips a pattern the way it strips a name.
@pytest.mark.parametrize(
    "name,pattern,hit",
    [
        ("d/sub/b.txt", "*/b.txt", True),
        ("d/sub/b.txt", "b.txt", False),
        ("sub/b.txt", "./sub/*", True),
    ],
)
def test_excluded_is_anchored_unlike_tars_exclude(name, pattern, hit):
    assert excluded(name, [pattern]) is hit


@pytest.mark.asyncio
async def test_y_stores_a_symlink_as_a_symlink():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d",))
    links = _links({"/d/link.txt": "a.txt"})
    _, io_res = await _zip(
        tree, [_spec("/out.zip"), _raw("/d", "d")], r=True, y=True, links=links
    )
    with zipfile.ZipFile(io.BytesIO(io_res.writes["/out.zip"])) as zf:
        info = zf.getinfo("d/link.txt")
        assert zf.read(info) == b"a.txt"
    assert info.external_attr >> 16 == 0o120777


@pytest.mark.asyncio
async def test_stops_at_a_nested_mount_and_says_so():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d", "/d/nested"))
    mounts = _mounts(descendants=("/d/nested",), roots=("/", "/d/nested"))
    _, io_res = await _zip(
        tree, [_spec("/out.zip"), _raw("/d", "d")], r=True, mounts=mounts
    )
    assert io_res.exit_code == 0
    assert (
        "\tzip warning: d/nested: file is on a different filesystem; "
        "not dumped\n" in io_res.stderr.decode()
    )
    # The mountpoint stays an entry; only its contents are left out.
    assert _entries(io_res.writes["/out.zip"]) == [
        "d/",
        "d/a.txt",
        "d/nested/",
    ]


@pytest.mark.asyncio
async def test_leaves_the_archive_out_of_itself():
    tree = _Tree({"/d/a.txt": b"alpha", "/d/old.zip": b"stale"}, dirs=("/d",))
    _, io_res = await _zip(
        tree, [_spec("/d/old.zip"), _raw("/d", "d")], r=True
    )
    assert _entries(io_res.writes["/d/old.zip"]) == ["d/", "d/a.txt"]


@pytest.mark.asyncio
async def test_requires_an_archive_operand():
    tree = _Tree({})
    with pytest.raises(ValueError, match="usage"):
        await _zip(tree, [])


@pytest.mark.asyncio
async def test_a_directory_the_walk_could_not_open_is_stored_in_silence():
    # Pinned on Info-ZIP 3.0 (debian:stable-slim) over a mode-000
    # directory: the directory entry is added, its contents are not,
    # and nothing is said about it.
    tree = _Tree(
        {"/d/a.txt": b"alpha", "/d/sealed/s": b"s"}, dirs=("/d", "/d/sealed")
    )
    tree.closed = ("/d/sealed",)
    out, io_res = await _zip(
        tree, [_spec("/out.zip"), _raw("/d", "d")], r=True
    )
    assert io_res.exit_code == 0
    assert io_res.stderr in (None, b"")
    assert _entries(io_res.writes["/out.zip"]) == [
        "d/",
        "d/a.txt",
        "d/sealed/",
    ]
    assert "sealed" not in out.decode().replace("  adding: d/sealed/\n", "")


@pytest.mark.asyncio
async def test_one_path_named_twice_is_stored_once():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d",))
    _, io_res = await _zip(
        tree,
        [
            _spec("/out.zip"),
            _raw("/d", "."),
            _raw("/d/a.txt", "a.txt"),
            _raw("/d/a.txt", "a.txt"),
        ],
        r=True,
    )
    assert io_res.exit_code == 0
    assert _entries(io_res.writes["/out.zip"]) == ["a.txt"]


@pytest.mark.asyncio
async def test_repeated_name_under_j_names_the_cause_and_q_keeps_the_error():
    tree = _Tree(
        {"/d/a.txt": b"alpha", "/d/sub/a.txt": b"again"}, dirs=("/d", "/d/sub")
    )
    paths = [
        _spec("/out.zip"),
        _raw("/d/sub/a.txt", "sub/a.txt"),
        _raw("/d/a.txt", "a.txt"),
    ]
    _, io_res = await _zip(tree, paths, j=True)
    assert io_res.exit_code == 16
    assert io_res.stderr.decode().startswith(
        "\tzip warning:   first full name: a.txt\n"
        "                      second full name: sub/a.txt\n"
        "                     name in zip file repeated: a.txt\n"
        "                     this may be a result of using -j\n"
    )
    _, quiet = await _zip(tree, paths, j=True, q=True)
    assert quiet.exit_code == 16
    assert quiet.stderr == (
        b"\nzip error: Invalid command arguments"
        b" (cannot repeat names in zip file)\n"
    )
