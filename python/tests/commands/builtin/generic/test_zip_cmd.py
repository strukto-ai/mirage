import io
import zipfile

import pytest

from mirage.commands.builtin.generic.zip_cmd import (excluded, member_name,
                                                     zip_cmd)
from mirage.ops.types import LinkView, MountView
from mirage.types import LINK_TARGET_KEY, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _spec(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _raw(path: str, raw: str, prefix: str = "") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path,
                    resolved=True,
                    raw_path=raw)


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
            return FileStat(name=key,
                            type=FileType.TEXT,
                            size=len(self.files[key]))
        raise FileNotFoundError(key)

    async def walk(self, path, find_type):
        base = path.virtual.rstrip("/") or "/"
        pool = self.dirs if find_type == "d" else self.files
        return sorted(p for p in pool
                      if p == base or p.startswith(base.rstrip("/") + "/"))


def _links(entries: dict[str, str]) -> LinkView:

    def stat_of(path):
        target = entries[path]
        return FileStat(name=path,
                        type=FileType.SYMLINK,
                        size=len(target),
                        extra={LINK_TARGET_KEY: target})

    async def target_stat(path):
        return None

    async def exists(path):
        return path in entries

    return LinkView(
        stat_at=lambda p: stat_of(p) if p in entries else None,
        children=lambda p: [],
        subtree=lambda p: [(k, stat_of(k)) for k in sorted(entries)
                           if k.startswith(p.rstrip("/") + "/")],
        resolve=lambda p: entries.get(p, p),
        exists=exists,
        target_stat=target_stat,
    )


def _mounts(descendants: tuple[str, ...] = (),
            roots: tuple[str, ...] = ()) -> MountView:

    def root_of(path):
        for root in sorted(roots, key=len, reverse=True):
            if path == root or path.startswith(root.rstrip("/") + "/"):
                return root
        return "/"

    return MountView(
        descendants=lambda p:
        [d for d in descendants if d.startswith(p.rstrip("/") + "/")],
        is_root=lambda p: p.rstrip("/") in {r.rstrip("/")
                                            for r in roots},
        root_of=root_of,
    )


async def _zip(tree: _Tree, paths, **flags):
    return await zip_cmd(paths,
                         read_bytes=tree.read_bytes,
                         write_bytes=tree.write_bytes,
                         stat=tree.stat,
                         walk=tree.walk,
                         **flags)


def _entries(archive: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        return [info.filename for info in zf.infolist()]


def test_member_name_strips_the_leading_slash_and_marks_directories():
    assert member_name("/d/a.txt", "file", False) == "d/a.txt"
    assert member_name("/d", "dir", False) == "d/"
    assert member_name("/d/sub/b.txt", "file", True) == "b.txt"
    assert member_name("link", "link", False) == "link"


def test_excluded_is_anchored_unlike_tars_exclude():
    assert excluded("d/sub/b.txt", ["d/sub/*"])
    assert excluded("d/sub/", ["d/sub/*"])
    assert excluded("d/a.txt", ["*.txt"])
    assert excluded("d/sub/b.txt", ["*/b.txt"])
    # Info-ZIP matches the whole stored name, so a bare component misses.
    assert not excluded("d/sub/b.txt", ["b.txt"])
    assert not excluded("d/sub/b.txt", ["sub/*"])


@pytest.mark.asyncio
async def test_recurses_a_directory_operand_under_r():
    tree = _Tree({
        "/d/a.txt": b"alpha",
        "/d/sub/b.txt": b"beta"
    },
                 dirs=("/d", "/d/sub", "/d/empty"))
    out, io_res = await _zip(
        tree, [_spec("/out.zip"), _raw("/d", "d")], r=True)
    assert io_res.exit_code == 0
    assert _entries(io_res.writes["/out.zip"]) == [
        "d/", "d/a.txt", "d/empty/", "d/sub/", "d/sub/b.txt"
    ]
    assert out.decode().startswith("  adding: d/\n")


@pytest.mark.asyncio
async def test_without_r_a_directory_stores_only_itself():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d", ))
    _, io_res = await _zip(tree, [_spec("/out.zip"), _raw("/d", "d")])
    assert _entries(io_res.writes["/out.zip"]) == ["d/"]


@pytest.mark.asyncio
async def test_directory_entries_carry_no_content():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d", ))
    _, io_res = await _zip(tree, [_spec("/out.zip"), _raw("/d", "d")], r=True)
    with zipfile.ZipFile(io.BytesIO(io_res.writes["/out.zip"])) as zf:
        info = zf.getinfo("d/")
    assert info.is_dir()
    assert info.file_size == 0


@pytest.mark.asyncio
async def test_junk_paths_drops_directories_and_keeps_basenames():
    tree = _Tree({
        "/d/a.txt": b"alpha",
        "/d/sub/b.txt": b"beta"
    },
                 dirs=("/d", "/d/sub"))
    _, io_res = await _zip(
        tree, [_spec("/out.zip"), _raw("/d", "d")], r=True, j=True)
    assert _entries(io_res.writes["/out.zip"]) == ["a.txt", "b.txt"]


@pytest.mark.asyncio
async def test_exclude_pattern_prunes_by_stored_name():
    tree = _Tree({
        "/d/a.txt": b"alpha",
        "/d/sub/b.txt": b"beta"
    },
                 dirs=("/d", "/d/sub"))
    _, io_res = await _zip(
        tree, [_spec("/out.zip"), _raw("/d", "d")], r=True, x=["d/sub/*"])
    assert _entries(io_res.writes["/out.zip"]) == ["d/", "d/a.txt"]


@pytest.mark.asyncio
async def test_follows_a_symlink_by_default():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d", ))
    links = _links({"/d/link.txt": "/d/a.txt"})
    _, io_res = await _zip(
        tree, [_spec("/out.zip"), _raw("/d", "d")], r=True, links=links)
    with zipfile.ZipFile(io.BytesIO(io_res.writes["/out.zip"])) as zf:
        assert zf.read("d/link.txt") == b"alpha"


@pytest.mark.asyncio
async def test_y_stores_a_symlink_as_a_symlink():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d", ))
    links = _links({"/d/link.txt": "a.txt"})
    _, io_res = await _zip(
        tree, [_spec("/out.zip"), _raw("/d", "d")],
        r=True,
        y=True,
        links=links)
    with zipfile.ZipFile(io.BytesIO(io_res.writes["/out.zip"])) as zf:
        info = zf.getinfo("d/link.txt")
        assert zf.read(info) == b"a.txt"
    assert info.external_attr >> 16 == 0o120777


@pytest.mark.asyncio
async def test_warns_on_a_name_it_cannot_match_but_still_archives_the_rest():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d", ))
    _, io_res = await _zip(tree, [
        _spec("/out.zip"),
        _raw("/d/a.txt", "d/a.txt"),
        _raw("/nope", "nope")
    ])
    assert io_res.exit_code == 0
    assert io_res.stderr.decode() == "\tzip warning: name not matched: nope\n"
    assert _entries(io_res.writes["/out.zip"]) == ["d/a.txt"]


@pytest.mark.asyncio
async def test_nothing_to_do_writes_no_archive_and_exits_twelve():
    tree = _Tree({})
    out, io_res = await _zip(
        tree, [_raw("/out.zip", "out.zip"),
               _raw("/nope", "nope")])
    assert out is None
    assert io_res.exit_code == 12
    assert not io_res.writes
    err = io_res.stderr.decode()
    assert err.startswith("\tzip warning: name not matched: nope\n")
    assert err.endswith("\nzip error: Nothing to do! (out.zip)\n")


@pytest.mark.asyncio
async def test_quiet_silences_the_warning_but_not_the_fatal_error():
    tree = _Tree({})
    _, io_res = await _zip(
        tree, [_raw("/out.zip", "out.zip"),
               _raw("/nope", "nope")], q=True)
    assert io_res.stderr.decode() == "\nzip error: Nothing to do! (out.zip)\n"


@pytest.mark.asyncio
async def test_quiet_prints_no_adding_lines():
    tree = _Tree({"/a.txt": b"alpha"})
    out, io_res = await _zip(
        tree, [_spec("/out.zip"), _raw("/a.txt", "a.txt")], q=True)
    assert out is None
    assert _entries(io_res.writes["/out.zip"]) == ["a.txt"]


@pytest.mark.asyncio
async def test_stops_at_a_nested_mount_and_says_so():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d", "/d/nested"))
    mounts = _mounts(descendants=("/d/nested", ), roots=("/", "/d/nested"))
    _, io_res = await _zip(
        tree, [_spec("/out.zip"), _raw("/d", "d")], r=True, mounts=mounts)
    assert io_res.exit_code == 0
    assert ("\tzip warning: d/nested: file is on a different filesystem; "
            "not dumped\n" in io_res.stderr.decode())
    # The mountpoint stays an entry; only its contents are left out.
    assert _entries(
        io_res.writes["/out.zip"]) == ["d/", "d/a.txt", "d/nested/"]


@pytest.mark.asyncio
async def test_leaves_the_archive_out_of_itself():
    tree = _Tree({"/d/a.txt": b"alpha", "/d/old.zip": b"stale"}, dirs=("/d", ))
    _, io_res = await _zip(
        tree, [_spec("/d/old.zip"), _raw("/d", "d")], r=True)
    assert _entries(io_res.writes["/d/old.zip"]) == ["d/", "d/a.txt"]


@pytest.mark.asyncio
async def test_names_members_on_a_prefixed_mount():
    tree = _Tree({"/data/d/a.txt": b"alpha"}, dirs=("/data", "/data/d"))
    await _zip(
        tree,
        [_spec("/data/out.zip", "/data"),
         _raw("/data/d", "/data/d", "/data")],
        r=True)
    assert _entries(tree.files["/data/out.zip"]) == ["data/d/", "data/d/a.txt"]


@pytest.mark.asyncio
async def test_requires_an_archive_operand():
    tree = _Tree({})
    with pytest.raises(ValueError, match="usage"):
        await _zip(tree, [])
