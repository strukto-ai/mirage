import pytest

from mirage.commands.builtin.generic.archive.types import Walked
from mirage.commands.builtin.generic.tar import (
    excluded,
    member_name,
    plan_create,
    pruned,
    strip_prefix,
)
from mirage.commands.builtin.generic.tar.types import CreateResult
from mirage.types import (
    ContentType,
    FileStat,
    FileType,
    PathSpec,
)
from mirage.utils.key_prefix import mount_key
from tests.fixtures.vfs_io import link_view as _links
from tests.fixtures.vfs_io import mount_view as _mounts


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


async def _plan(
    tree: _Tree, paths, dereference: bool = False, **options
) -> CreateResult:
    return await plan_create(
        paths,
        archive=_spec("/out.tar"),
        exclude=None,
        dereference=dereference,
        stat=tree.stat,
        walk=tree.walk,
        is_dir=tree.is_dir,
        **options,
    )


def _names(plan: CreateResult) -> list[str]:
    return [member.name for member in plan.members]


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
async def test_create_announces_a_prefix_and_plans_what_it_could_stat():
    tree = _Tree({"/base/file": b"x"}, dirs=("/base", "/base/sub"))
    plan = await _plan(
        tree, [_raw("/base/file", "../file"), _raw("/base/nope", "nope")]
    )
    assert plan.exit_code == 2
    assert plan.notices == (
        "tar: Removing leading `../' from member names",
        "tar: nope: Cannot stat: No such file or directory",
    )
    assert _names(plan) == ["file"]


@pytest.mark.asyncio
async def test_create_plans_a_symlink_as_a_symlink():
    """The router must not dereference an operand before the planner sees
    it, and a walk must not dereference what it meets.
    """
    tree = _Tree({"/d/a.txt": b"a"}, dirs=("/d",))
    links = _links({"/d/link.txt": "a.txt", "/link": "/d/a.txt"})
    plan = await _plan(tree, [_raw("/d", "d"), _raw("/link", "link")], links=links)
    stored = {m.name: m.target for m in plan.members if m.kind == "link"}
    assert stored == {"d/link.txt": "a.txt", "link": "/d/a.txt"}


@pytest.mark.asyncio
async def test_dereference_reports_a_dangling_link_and_exits_two():
    tree = _Tree({"/d/a.txt": b"alpha"}, dirs=("/d",))
    links = _links({"/d/bad": "/d/nope"})
    plan = await _plan(tree, [_raw("/d", "d")], dereference=True, links=links)
    assert plan.exit_code == 2
    assert any("tar: d/bad: Cannot stat" in line for line in plan.notices)


@pytest.mark.asyncio
async def test_create_stops_at_a_nested_mount_and_says_so():
    tree = _Tree({"/d/a.txt": b"a"}, dirs=("/d", "/d/nested"))
    mounts = _mounts(descendants=("/d/nested",), roots=("/", "/d/nested"))
    plan = await _plan(tree, [_raw("/d", "d")], mounts=mounts)
    assert plan.exit_code == 0
    assert plan.notices == (
        "tar: d/nested/: file is on a different filesystem; not dumped",
    )
    # The mountpoint stays an entry; only its contents are left out.
    assert _names(plan) == ["d/", "d/a.txt", "d/nested/"]


@pytest.mark.asyncio
async def test_create_reports_a_directory_it_may_not_open_and_keeps_it():
    # Pinned on GNU tar 1.35 (debian:stable-slim) over a mode-000
    # directory: "Cannot open: Permission denied", named as the operand was
    # typed, its own entry kept, exit 2.
    tree = _Tree(
        {"/d/a.txt": b"x", "/d/sealed/s": b"s"}, dirs=("/d", "/d/sealed")
    )
    tree.closed = ("/d/sealed",)
    plan = await _plan(tree, [_raw("/d", "/d")])
    assert plan.exit_code == 2
    assert plan.notices == (
        "tar: Removing leading `/' from member names",
        "tar: /d/sealed: Cannot open: Permission denied",
    )
    assert _names(plan) == ["d/", "d/a.txt", "d/sealed/"]
