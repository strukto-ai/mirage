from dataclasses import replace

import pytest

from mirage.commands.builtin.generic.archive import walk as aw
from mirage.commands.builtin.generic.archive.types import Walked
from mirage.errors.fs import fs_error
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.types import (
    ContentType,
    FileStat,
    FileType,
    PathSpec,
)
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import CycleError
from mirage.view.types import LinkView, MountView
from tests.fixtures.vfs_io import link_view as _links


def _spec(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path,
        resolved=True,
    )


class _Tree:
    def __init__(self, files: dict[str, bytes], dirs: tuple[str, ...] = ()):
        self.files = dict(files)
        self.dirs = set(dirs)

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


def _cycle(entries: dict[str, str]) -> LinkView:
    """A LinkView whose resolve raises ELOOP, as the namespace does."""
    view = _links(entries)

    def resolve(path):
        raise CycleError(path)

    return replace(view, resolve=resolve)


def _mounts(
    descendants: tuple[str, ...] = (),
    roots: tuple[str, ...] = (),
    hidden: tuple[str, ...] = (),
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
            d
            for d in descendants
            if d.startswith(p.rstrip("/") + "/") and d not in hidden
        ],
        is_root=lambda p: p.rstrip("/") in {r.rstrip("/") for r in roots},
        root_of=root_of,
    )


_REFUSALS = [
    pytest.param(FsCondition.EACCES, id="eacces"),
    pytest.param(FsCondition.EPERM, id="eperm"),
    pytest.param(FsCondition.EROFS, id="erofs"),
]


def _refusing(at: str, why: FsCondition, tree: "_Tree | None" = None):
    async def stat(path: PathSpec) -> FileStat:
        if path.virtual == at:
            raise fs_error(path, why)
        assert tree is not None
        return await tree.stat(path)

    return stat


async def _scan(tree: _Tree, path: PathSpec, **kwargs):
    return await aw.scan_operand(
        path, stat=tree.stat, walk=tree.walk, **kwargs
    )


def test_child_spec_strips_the_mount_prefix_from_the_backend_key():
    root = _spec("/data/d", "/data")
    child = aw._child_spec("/data/d/a.txt", root)
    assert child.virtual == "/data/d/a.txt"
    assert child.vfs_path == "d/a.txt"


def test_same_mount_is_true_without_a_mount_view():
    assert aw._same_mount(None, "/a", "/b")
    mounts = _mounts(roots=("/", "/m"))
    assert aw._same_mount(mounts, "/a", "/b")
    assert not aw._same_mount(mounts, "/a", "/m/x")


@pytest.mark.asyncio
async def test_recurse_false_stops_at_the_directory_itself():
    tree = _Tree({"/d/a.txt": b"a"}, dirs=("/d", "/d/sub"))
    scan = await _scan(tree, _spec("/d"), recurse=False)
    assert [e.name_path for e in scan.entries] == ["/d"]
    assert scan.entries[0].kind == "dir"


@pytest.mark.asyncio
async def test_recurse_true_reports_the_whole_subtree_sorted():
    tree = _Tree(
        {"/d/a.txt": b"a", "/d/sub/b.txt": b"b"}, dirs=("/d", "/d/sub")
    )
    scan = await _scan(tree, _spec("/d"), recurse=True)
    assert [e.name_path for e in scan.entries] == [
        "/d",
        "/d/a.txt",
        "/d/sub",
        "/d/sub/b.txt",
    ]


@pytest.mark.asyncio
async def test_a_missing_operand_is_one_fatal_problem_and_no_entries():
    tree = _Tree({})
    scan = await _scan(tree, _spec("/nope"))
    assert scan.missing
    assert not scan.entries
    assert [(p.path, p.fatal) for p in scan.problems] == [("/nope", True)]


@pytest.mark.asyncio
@pytest.mark.parametrize("why", _REFUSALS)
async def test_a_refused_operand_is_one_fatal_problem_said_as_refused(why):
    # GNU tar: `Cannot stat: Permission denied`, the other operands go on;
    # a refusal keeps its own errno.
    tree = _Tree({})
    scan = await aw.scan_operand(
        _spec("/rd/b.txt"), stat=_refusing("/rd/b.txt", why), walk=tree.walk
    )
    assert scan.missing
    assert [(p.path, p.reason, p.fatal) for p in scan.problems] == [
        ("/rd/b.txt", posix_phrase(why), True)
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("why", _REFUSALS)
async def test_a_link_to_a_refused_target_is_one_fatal_problem(why):
    # GNU tar -h: `l: Cannot stat: Permission denied`, the rest go on.
    tree = _Tree({"/rd/b.txt": b"b"}, dirs=("/rd",))
    scan = await aw.scan_operand(
        _spec("/rd/l"),
        stat=_refusing("/rd/b.txt", why, tree),
        walk=tree.walk,
        links=_links({"/rd/l": "/rd/b.txt"}),
        dereference=True,
    )
    assert scan.missing
    assert [(p.path, p.reason, p.fatal) for p in scan.problems] == [
        ("/rd/l", posix_phrase(why), True)
    ]


@pytest.mark.asyncio
async def test_a_link_is_stored_or_followed_by_the_dereference_flag():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d",))
    links = _links({"/d/link.txt": "/d/a.txt"})
    stored = await _scan(
        tree, _spec("/d"), links=links, dereference=False, recurse=True
    )
    kinds = {e.name_path: e.kind for e in stored.entries}
    assert kinds["/d/link.txt"] == "link"
    followed = await _scan(
        tree, _spec("/d"), links=links, dereference=True, recurse=True
    )
    kinds = {e.name_path: e.kind for e in followed.entries}
    assert kinds["/d/link.txt"] == "file"


@pytest.mark.asyncio
async def test_two_links_to_one_target_are_both_archived():
    """Not a loop: GNU tar -h and Info-ZIP both store the two names."""
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d",))
    links = _links({"/d/one": "/d/a.txt", "/d/two": "/d/a.txt"})
    scan = await _scan(
        tree, _spec("/d"), links=links, dereference=True, recurse=True
    )
    assert not scan.problems
    names = {e.name_path for e in scan.entries}
    assert {"/d/one", "/d/two"} <= names


@pytest.mark.asyncio
async def test_a_real_cycle_is_one_fatal_problem_per_member():
    tree = _Tree({}, dirs=("/d",))
    links = _cycle({"/d/a": "/d/b", "/d/b": "/d/a"})
    scan = await _scan(
        tree, _spec("/d"), links=links, dereference=True, recurse=True
    )
    assert [(p.path, p.reason, p.fatal) for p in scan.problems] == [
        ("/d/a", posix_phrase(FsCondition.ELOOP), True),
        ("/d/b", posix_phrase(FsCondition.ELOOP), True),
    ]
    # GNU keeps the directory entry and exits 2; it does not abort.
    assert [e.name_path for e in scan.entries] == ["/d"]


@pytest.mark.asyncio
async def test_a_dangling_link_is_fatal_with_the_enoent_wording():
    tree = _Tree({}, dirs=("/d",))
    links = _links({"/d/bad": "/d/nowhere"})
    scan = await _scan(
        tree, _spec("/d"), links=links, dereference=True, recurse=True
    )
    assert [(p.reason, p.fatal) for p in scan.problems] == [
        (posix_phrase(FsCondition.ENOENT), True)
    ]


@pytest.mark.asyncio
async def test_a_nested_mount_is_reported_and_its_contents_dropped():
    tree = _Tree(
        {"/d/a.txt": b"a", "/d/nested/deep.txt": b"deep"},
        dirs=("/d", "/d/nested"),
    )
    mounts = _mounts(descendants=("/d/nested",), roots=("/", "/d/nested"))
    scan = await _scan(tree, _spec("/d"), mounts=mounts, recurse=True)
    assert scan.crossings == ("/d/nested",)
    names = [e.name_path for e in scan.entries]
    assert names == ["/d", "/d/a.txt", "/d/nested"]


@pytest.mark.asyncio
async def test_a_hidden_nested_mount_prunes_but_is_never_named():
    # The two questions the view answers apart. Pruning reads every
    # descendant, so the parent backend's keys shadowed by the mount
    # stay out of the archive; naming reads only the visible ones, so
    # neither a member nor a "different filesystem" warning hands back
    # the name the session's hides withhold.
    # The mountpoint is not the parent's own directory entry (it belongs
    # to another VFS), but the parent backend does hold a key that
    # the mount shadows, which is what pruning has to catch.
    tree = _Tree(
        {"/d/a.txt": b"a", "/d/nested/deep.txt": b"deep"}, dirs=("/d",)
    )
    mounts = _mounts(
        descendants=("/d/nested",),
        roots=("/", "/d/nested"),
        hidden=("/d/nested",),
    )
    scan = await _scan(tree, _spec("/d"), mounts=mounts, recurse=True)
    assert scan.crossings == ()
    names = [e.name_path for e in scan.entries]
    assert names == ["/d", "/d/a.txt"]


@pytest.mark.asyncio
async def test_a_link_across_a_mount_is_refused_not_followed():
    tree = _Tree({"/d/a.txt": b"a"}, dirs=("/d",))
    links = _links({"/d/away": "/m/x.txt"})
    mounts = _mounts(roots=("/", "/m"))
    scan = await _scan(
        tree,
        _spec("/d"),
        links=links,
        mounts=mounts,
        dereference=True,
        recurse=True,
    )
    assert [(p.path, p.reason) for p in scan.problems] == [
        ("/d/away", aw.OTHER_FILESYSTEM)
    ]


@pytest.mark.asyncio
async def test_a_directory_the_walk_could_not_open_is_one_unreadable_problem():
    # Its own entry is kept (the archivers store the directory), its
    # contents are not there, and both listings meeting the same
    # refusal report it once.
    tree = _Tree(
        {"/d/a.txt": b"a", "/d/sealed/s": b"s"}, dirs=("/d", "/d/sealed")
    )
    tree.closed = ("/d/sealed",)
    scan = await _scan(tree, _spec("/d"), recurse=True)
    assert [e.name_path for e in scan.entries] == [
        "/d",
        "/d/a.txt",
        "/d/sealed",
    ]
    assert scan.problems == (
        aw.Problem(
            path="/d/sealed", reason="Permission denied", unreadable=True
        ),
    )
    assert not scan.missing
