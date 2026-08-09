import io
import tarfile
from dataclasses import replace

import pytest

from mirage.commands.builtin.generic.tar import (excluded, member_name, pruned,
                                                 tar)
from mirage.ops.types import LinkView, MountView
from mirage.types import LINK_TARGET_KEY, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import CycleError


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

    async def mkdir(self, path, parents=False):
        self.dirs.add(path.virtual.rstrip("/"))

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

    async def is_dir(self, path):
        return (path.virtual.rstrip("/") or "/") in self.dirs


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


def _cycle(entries: dict[str, str]) -> LinkView:
    """A LinkView whose resolve raises ELOOP, as the namespace does."""

    def resolve(path):
        raise CycleError(path)

    return replace(_links(entries), resolve=resolve)


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


async def _create(tree: _Tree, paths, **flags):
    return await tar(paths,
                     read_bytes=tree.read_bytes,
                     write_bytes=tree.write_bytes,
                     mkdir_fn=tree.mkdir,
                     stat=tree.stat,
                     walk=tree.walk,
                     is_dir=tree.is_dir,
                     **flags)


def _names(archive: bytes) -> list[str]:
    with tarfile.open(fileobj=io.BytesIO(archive)) as tf:
        return [
            member.name + "/" if member.isdir() else member.name
            for member in tf.getmembers()
        ]


def test_excluded_matches_whole_name_and_every_component_suffix():
    assert excluded("d/a.txt", "d/a.txt")
    assert excluded("d/a.txt", "a.txt")
    assert excluded("d/sub/b.txt", "sub/b.txt")
    assert excluded("d/sub/b.txt", "*/b.txt")
    assert excluded("d/sub/", "sub")
    assert not excluded("d/a.txt", "b.txt")
    # The pattern is anchored at a component boundary, not mid-name.
    assert not excluded("d/abc.txt", "bc.txt")


def test_pruned_takes_the_children_of_an_excluded_directory():
    names = ["d/", "d/a.txt", "d/sub/", "d/sub/b.txt"]
    assert pruned(names, "sub") == ["d/", "d/a.txt"]
    assert pruned(names, "sub/b.txt") == ["d/", "d/a.txt", "d/sub/"]
    assert pruned(names, None) == names


def test_member_name_strips_the_leading_slash_and_marks_directories():
    assert member_name("/data/d/a.txt", "file") == "data/d/a.txt"
    assert member_name("/data/d", "dir") == "data/d/"
    assert member_name("d/", "dir") == "d/"
    assert member_name("link", "link") == "link"


@pytest.mark.asyncio
async def test_create_walks_a_directory_operand():
    tree = _Tree({
        "/d/a.txt": b"alpha",
        "/d/sub/b.txt": b"beta"
    },
                 dirs=("/d", "/d/sub", "/d/empty"))
    out, io_res = await _create(tree, [_raw("/d", "d")],
                                c=True,
                                v=True,
                                f=_spec("/out.tar"))
    assert io_res.exit_code == 0
    assert out.decode().split() == [
        "d/", "d/a.txt", "d/empty/", "d/sub/", "d/sub/b.txt"
    ]
    assert _names(io_res.writes["/out.tar"]) == [
        "d/", "d/a.txt", "d/empty/", "d/sub/", "d/sub/b.txt"
    ]


@pytest.mark.asyncio
async def test_create_keeps_an_empty_directory_as_its_own_member():
    tree = _Tree({"/d/a.txt": b"x"}, dirs=("/d", "/d/empty"))
    _, io_res = await _create(tree, [_raw("/d", "d")],
                              c=True,
                              f=_spec("/out.tar"))
    assert "d/empty/" in _names(io_res.writes["/out.tar"])


@pytest.mark.asyncio
async def test_create_names_members_as_the_operand_was_typed():
    tree = _Tree({"/base/d/a.txt": b"x"}, dirs=("/base", "/base/d"))
    _, io_res = await _create(tree, [_raw("/base/d", "d")],
                              c=True,
                              f=_spec("/out.tar"))
    assert _names(io_res.writes["/out.tar"]) == ["d/", "d/a.txt"]


@pytest.mark.asyncio
async def test_create_warns_once_about_a_stripped_leading_slash():
    tree = _Tree({"/d/a.txt": b"x"}, dirs=("/d", ))
    _, io_res = await _create(tree, [_spec("/d")], c=True, f=_spec("/out.tar"))
    assert io_res.stderr.decode().count("Removing leading") == 1
    assert _names(io_res.writes["/out.tar"]) == ["d/", "d/a.txt"]


@pytest.mark.asyncio
async def test_create_reports_a_missing_operand_and_exits_two():
    tree = _Tree({"/d/a.txt": b"x"}, dirs=("/d", ))
    _, io_res = await _create(
        tree, [_raw("/nope", "nope"), _raw("/d", "d")],
        c=True,
        f=_spec("/out.tar"))
    assert io_res.exit_code == 2
    err = io_res.stderr.decode()
    assert "tar: nope: Cannot stat: No such file or directory" in err
    assert "Exiting with failure status due to previous errors" in err
    # GNU still archives every operand it could read.
    assert "d/a.txt" in _names(io_res.writes["/out.tar"])


@pytest.mark.asyncio
async def test_create_refuses_an_empty_archive():
    tree = _Tree({})
    out, io_res = await _create(tree, [], c=True, f=_spec("/out.tar"))
    assert out is None
    assert io_res.exit_code == 2
    assert "Cowardly refusing" in io_res.stderr.decode()
    assert not io_res.writes


@pytest.mark.asyncio
async def test_create_refuses_a_directory_it_cannot_enter():
    tree = _Tree({"/d/a.txt": b"x"}, dirs=("/d", ))
    _, io_res = await _create(tree, [_raw("/nodir/a.txt", "a.txt")],
                              c=True,
                              f=_spec("/out.tar"),
                              C=[_raw("/nodir", "nodir")])
    assert io_res.exit_code == 2
    err = io_res.stderr.decode()
    assert "tar: nodir: Cannot open: No such file or directory" in err
    assert "Error is not recoverable: exiting now" in err
    assert not io_res.writes


@pytest.mark.asyncio
async def test_create_prunes_an_excluded_subtree():
    tree = _Tree({
        "/d/a.txt": b"a",
        "/d/sub/b.txt": b"b"
    },
                 dirs=("/d", "/d/sub"))
    _, io_res = await _create(tree, [_raw("/d", "d")],
                              c=True,
                              f=_spec("/out.tar"),
                              exclude="sub")
    assert _names(io_res.writes["/out.tar"]) == ["d/", "d/a.txt"]


@pytest.mark.asyncio
async def test_create_stores_a_symlink_as_a_symlink():
    tree = _Tree({"/d/a.txt": b"a"}, dirs=("/d", ))
    links = _links({"/d/link.txt": "a.txt"})
    _, io_res = await _create(tree, [_raw("/d", "d")],
                              c=True,
                              f=_spec("/out.tar"),
                              links=links)
    with tarfile.open(fileobj=io.BytesIO(io_res.writes["/out.tar"])) as tf:
        link = tf.getmember("d/link.txt")
    assert link.issym()
    assert link.linkname == "a.txt"


@pytest.mark.asyncio
async def test_dereference_stores_the_target_content_under_the_link_name():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d", ))
    links = _links({"/d/link.txt": "/d/a.txt"})
    _, io_res = await _create(tree, [_raw("/d", "d")],
                              c=True,
                              h=True,
                              f=_spec("/out.tar"),
                              links=links)
    with tarfile.open(fileobj=io.BytesIO(io_res.writes["/out.tar"])) as tf:
        member = tf.getmember("d/link.txt")
        assert not member.issym()
        assert tf.extractfile(member).read() == b"alpha"


@pytest.mark.asyncio
async def test_dereference_reports_a_dangling_link_and_exits_two():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d", ))
    links = _links({"/d/bad": "/d/nope"})
    _, io_res = await _create(tree, [_raw("/d", "d")],
                              c=True,
                              h=True,
                              f=_spec("/out.tar"),
                              links=links)
    assert io_res.exit_code == 2
    assert "tar: d/bad: Cannot stat" in io_res.stderr.decode()


@pytest.mark.asyncio
async def test_create_stops_at_a_nested_mount_and_says_so():
    tree = _Tree({"/d/a.txt": b"a"}, dirs=("/d", "/d/nested"))
    mounts = _mounts(descendants=("/d/nested", ), roots=("/", "/d/nested"))
    _, io_res = await _create(tree, [_raw("/d", "d")],
                              c=True,
                              f=_spec("/out.tar"),
                              mounts=mounts)
    assert io_res.exit_code == 0
    assert ("tar: d/nested/: file is on a different filesystem; not dumped"
            in io_res.stderr.decode())
    # The mountpoint stays an entry; only its contents are left out.
    assert _names(io_res.writes["/out.tar"]) == ["d/", "d/a.txt", "d/nested/"]


@pytest.mark.asyncio
async def test_create_leaves_the_archive_out_of_itself():
    tree = _Tree({"/d/a.txt": b"a", "/d/old.tar": b"stale"}, dirs=("/d", ))
    _, io_res = await _create(tree, [_raw("/d", "d")],
                              c=True,
                              f=_spec("/d/old.tar"))
    assert "archive cannot contain itself" in io_res.stderr.decode()
    assert _names(io_res.writes["/d/old.tar"]) == ["d/", "d/a.txt"]


@pytest.mark.asyncio
async def test_create_and_list_round_trip_plain_files():
    tree = _Tree({"/a.txt": b"alpha", "/b.txt": b"beta"})
    _, io_res = await _create(
        tree, [_spec("/a.txt"), _spec("/b.txt")], c=True, f=_spec("/out.tar"))
    assert "/out.tar" in io_res.writes
    out, _ = await _create(tree, [], t=True, f=_spec("/out.tar"))
    assert out.decode().split() == ["a.txt", "b.txt"]


@pytest.mark.asyncio
async def test_extract_recreates_directories_including_empty_ones():
    tree = _Tree({"/d/a.txt": b"x"}, dirs=("/d", "/d/empty"))
    _, io_res = await _create(tree, [_raw("/d", "d")],
                              c=True,
                              f=_spec("/out.tar"))
    tree.files["/out.tar"] = io_res.writes["/out.tar"]
    _, io_res = await _create(tree, [],
                              x=True,
                              f=_spec("/out.tar"),
                              C=[_spec("/out")])
    assert any("d/a.txt" in path for path in io_res.writes)
    assert "/out/d/empty" in tree.dirs


@pytest.mark.asyncio
async def test_extract_strips_leading_components():
    tree = _Tree({"/deep/d/a.txt": b"x"}, dirs=("/deep", "/deep/d"))
    _, io_res = await _create(tree, [_spec("/deep/d")],
                              c=True,
                              f=_spec("/out.tar"))
    tree.files["/out.tar"] = io_res.writes["/out.tar"]
    _, io_res = await _create(tree, [],
                              x=True,
                              f=_spec("/out.tar"),
                              strip_components="2",
                              C=[_spec("/out")])
    assert "/out/a.txt" in io_res.writes


@pytest.mark.asyncio
async def test_requires_a_mode():
    tree = _Tree({})
    with pytest.raises(ValueError, match="-c, -x, or -t"):
        await _create(tree, [])


@pytest.mark.asyncio
async def test_requires_an_archive():
    tree = _Tree({"/a.txt": b"x"})
    with pytest.raises(ValueError, match="-f is required"):
        await _create(tree, [_spec("/a.txt")], c=True)


@pytest.mark.asyncio
async def test_create_fails_at_the_first_unenterable_c_not_the_last():
    """GNU chdirs at each -C, so a bad early one stops the whole run.

    Checking only the parsed flag's final value archived the operands
    that followed the bad one and named the wrong subject.
    """
    tree = _Tree({"/good/y.txt": b"y"}, dirs=("/good", ))
    _, io_res = await _create(
        tree, [_raw("/good/y.txt", "y.txt")],
        c=True,
        f=_spec("/out.tar"),
        C=[_raw("/missing", "missing"),
           _raw("/good", "good")])
    assert io_res.exit_code == 2
    err = io_res.stderr.decode()
    assert "tar: missing: Cannot open: No such file or directory" in err
    assert "Error is not recoverable" in err
    assert not io_res.writes


@pytest.mark.asyncio
async def test_two_links_to_one_target_are_not_a_loop():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d", ))
    links = _links({"/d/one": "/d/a.txt", "/d/two": "/d/a.txt"})
    _, io_res = await _create(tree, [_raw("/d", "d")],
                              c=True,
                              h=True,
                              f=_spec("/out.tar"),
                              links=links)
    assert io_res.exit_code == 0
    assert io_res.stderr == b""
    assert _names(
        io_res.writes["/out.tar"]) == ["d/", "d/a.txt", "d/one", "d/two"]


@pytest.mark.asyncio
async def test_a_symlink_cycle_is_reported_per_member_and_keeps_the_directory(
):
    tree = _Tree({}, dirs=("/d", ))
    links = _cycle({"/d/a": "/d/b", "/d/b": "/d/a"})
    _, io_res = await _create(tree, [_raw("/d", "d")],
                              c=True,
                              h=True,
                              f=_spec("/out.tar"),
                              links=links)
    assert io_res.exit_code == 2
    err = io_res.stderr.decode()
    assert "tar: d/a: Cannot stat: Too many levels of symbolic links" in err
    assert "tar: d/b: Cannot stat: Too many levels of symbolic links" in err
    # GNU keeps the directory entry rather than aborting the archive.
    assert _names(io_res.writes["/out.tar"]) == ["d/"]


@pytest.mark.asyncio
async def test_a_symlink_operand_is_stored_as_a_symlink():
    """The router must not dereference it before the planner sees it."""
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d", ))
    links = _links({"/link": "/d/a.txt"})
    _, io_res = await _create(tree, [_raw("/link", "link")],
                              c=True,
                              f=_spec("/out.tar"),
                              links=links)
    with tarfile.open(fileobj=io.BytesIO(io_res.writes["/out.tar"])) as tf:
        member = tf.getmember("link")
    assert member.issym()
    assert member.size == 0
    assert member.linkname == "/d/a.txt"
