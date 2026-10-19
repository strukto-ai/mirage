# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from typing import Any

import pytest

from mirage.commands.builtin.utils.links import (
    LinkResolver,
    crosses_mounts,
    link_resolver,
    link_view,
    mount_root,
    mount_view,
    mounts_of,
    name_location,
    owed_names,
    typed_link,
)
from mirage.commands.config import Context
from mirage.context import reset_mount_gate, set_mount_gate
from mirage.errors.types import DotWalkLoop
from mirage.io.types import IOResult
from mirage.types import (
    FileStat,
    FileType,
    HiddenPaths,
    MountMode,
    PathSpec,
    Visibility,
)
from mirage.utils.path import CycleError
from mirage.view.types import LinkView
from mirage.workspace.files import Files
from mirage.workspace.types import MountRow
from tests.fixtures.readers import readers


def _spec(
    virtual: str, raw_path: str, walk_error: str | None = None
) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0] or "/",
        vfs_path=virtual.lstrip("/"),
        raw_path=raw_path,
        walk_error=walk_error,
    )


def _links(table: dict[str, str]) -> LinkView:
    """A LinkView over a table of link paths and what each one names.

    Args:
        table (dict[str, str]): each link's path and its target, which
            ``resolve`` follows from any path under the link too.
    """

    def resolve(path: str) -> str:
        if table.get(path) == path:
            raise CycleError(path)
        for link, target in table.items():
            if path == link or path.startswith(link + "/"):
                return target + path[len(link) :]
        return path

    async def target_stat(path: str) -> FileStat | None:
        return None

    async def exists(path: str) -> bool:
        return False

    return LinkView(
        stat_at=lambda path: (
            FileStat(name=path.rsplit("/", 1)[-1], type=FileType.SYMLINK)
            if path in table
            else None
        ),
        subtree=lambda directory: [],
        resolve=resolve,
        exists=exists,
        target_stat=target_stat,
    )


LINKS = _links({"/data/dl": "/data/dir", "/data/dir/tl.gz": "/data/t.gz"})


class _Table:
    """A namespace link table over link paths and their targets.

    Args:
        targets (dict[str, str]): each link's path and what it names.
    """

    def __init__(self, targets: dict[str, str]) -> None:
        self._targets = targets

    def follow(self, path: str) -> str:
        return self._targets.get(path, path)

    def link_stat_at(self, path: str) -> FileStat | None:
        if path not in self._targets:
            return None
        return FileStat(name=path.rsplit("/", 1)[-1], type=FileType.SYMLINK)

    def link_stats_below(self, directory: str) -> list[tuple[str, FileStat]]:
        base = directory.rstrip("/") + "/"
        return [
            (path, row)
            for path in sorted(self._targets)
            if path.startswith(base)
            and (row := self.link_stat_at(path)) is not None
        ]

    def symlink_targets(self) -> dict[str, str]:
        return dict(self._targets)


def _rows(*prefixes: str) -> list[MountRow]:
    return [
        MountRow(prefix=p, resource_type="ram", mode=MountMode.READ)
        for p in prefixes
    ]


def test_a_name_stands_in_the_directory_its_parent_link_names():
    # The router left `virtual` at the target; the name is still the link.
    typed = _spec("/data/t.gz", "dl/tl.gz")
    assert name_location(LINKS, typed, "/data") == "/data/dir/tl.gz"
    assert typed_link(LINKS, typed, "/data") is not None


@pytest.mark.parametrize("raw", ["dl/tl.gz/", "dl/.", "dl/.."])
def test_a_name_whose_last_component_resolves_stands_nowhere(raw: str):
    assert name_location(LINKS, _spec("/data/dir", raw), "/data") is None


def test_a_name_whose_walk_failed_stands_nowhere():
    looped = _spec("/data/l1", "l1", walk_error="ELOOP")
    assert name_location(LINKS, looped, "/data") is None


def test_a_plain_name_is_no_link():
    assert typed_link(LINKS, _spec("/data/a.txt", "a.txt"), "/data") is None


class _Dispatch:
    """A dispatcher that records the ops it is asked for."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    async def __call__(
        self, op: str, path: PathSpec, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        self.calls.append((op, path.virtual, kwargs))
        if op == "read":
            return b"through the dispatcher", IOResult()
        if op == "readdir":
            return (f"{path.virtual}/a", f"{path.virtual}/b"), IOResult()
        return FileStat(name="n", type=FileType.SYMLINK), IOResult()


@pytest.mark.asyncio
async def test_the_dispatcher_reads_writes_and_unlinks_by_the_name_it_is_handed():
    calls = _Dispatch()
    resolver = LinkResolver(links=LINKS, dispatch=calls, cwd="/data")
    assert [c async for c in resolver.read("/data/dir/tl.gz")] == [
        b"through the dispatcher"
    ]
    await resolver.write("/data/dir/tl", b"x")
    await resolver.unlink("/data/dir/tl.gz")
    await resolver.lstat(PathSpec.from_str_path("/data/dir/tl.gz"))
    assert calls.calls == [
        ("read", "/data/dir/tl.gz", {"stream": True}),
        ("write", "/data/dir/tl", {"data": b"x"}),
        ("unlink", "/data/dir/tl.gz", {}),
        ("stat", "/data/dir/tl.gz", {"nofollow": True}),
    ]


def test_a_link_the_router_followed_can_vanish_before_its_turn():
    resolver = LinkResolver(
        links=_links({}), dispatch=_Dispatch(), cwd="/data"
    )
    followed = _spec("/data/t.gz", "tl.gz")
    assert resolver.vanished(followed)
    assert resolver.link_at(followed) is None
    assert not resolver.vanished(_spec("/data/t.gz", "t.gz"))


def test_an_invocation_without_files_or_links_has_no_link_resolver():
    files = Files(_Dispatch(), readers(links=_Table({})))
    assert link_resolver(Context()) is None
    assert link_resolver(Context(vfs=Files(_Dispatch()))) is None
    resolver = link_resolver(Context(vfs=files))
    assert resolver is not None and resolver.cwd == "/"
    assert resolver.dispatch == files.dispatch


@pytest.mark.asyncio
async def test_the_dispatcher_lists_and_stats_by_the_name_it_is_handed():
    calls = _Dispatch()
    resolver = LinkResolver(links=LINKS, dispatch=calls, cwd="/data")
    assert await resolver.readdir("/data/dir") == [
        "/data/dir/a",
        "/data/dir/b",
    ]
    assert (await resolver.stat("/data/t.gz")).name == "n"
    assert calls.calls == [
        ("readdir", "/data/dir", {}),
        ("stat", "/data/t.gz", {}),
    ]


def test_a_link_leads_where_the_table_resolves_it():
    resolver = LinkResolver(links=LINKS, dispatch=_Dispatch(), cwd="/data")
    assert resolver.target("/data/dir/tl.gz") == "/data/t.gz"


def test_a_looping_link_is_the_eloop_a_walker_reports():
    resolver = LinkResolver(
        links=_links({"/data/l": "/data/l"}), dispatch=_Dispatch(), cwd="/data"
    )
    with pytest.raises(DotWalkLoop):
        resolver.target("/data/l")


def test_owed_names_derive_from_the_mount_table():
    files = Files(
        _Dispatch(), readers(_rows("/base/", "/base/inner/", "/dev/"))
    )
    assert owed_names(files, "/base") == ["inner"]
    assert owed_names(files, "/") == ["base", "dev"]
    assert owed_names(files, "/dev") == []


def test_owed_names_include_link_ancestors():
    # A link below a directory chain no backend serves synthesizes its
    # ancestors, exactly as a nested mount prefix does, so `ls /` shows
    # the way to it.
    files = Files(
        _Dispatch(),
        readers(_rows("/base/"), _Table({"/ghost/deep/lnk": "/base"})),
    )
    assert owed_names(files, "/") == ["base", "ghost"]
    assert owed_names(files, "/ghost") == ["deep"]
    assert owed_names(None, "/") == []


def test_a_link_view_is_live_whenever_the_files_hold_a_table():
    table = _Table({})
    view = link_view(Files(_Dispatch(), readers(links=table)))
    assert view is not None
    assert view.subtree("/") == []
    table._targets["/data/l"] = "/data/a"
    assert view.stat_at("/data/l") is not None
    assert link_view(Files(_Dispatch())) is None
    assert link_view(None) is None


@pytest.mark.asyncio
async def test_a_link_the_session_cannot_see_is_never_answered():
    # A hidden link, and a visible one that leads where the session
    # cannot see, have no row, no subtree entry, no owed name and no
    # target; resolving a hidden path leaves it as typed.
    hidden = Visibility(paths=HiddenPaths(paths=("/data/secret",)))
    files = Files(
        _Dispatch(),
        readers(
            _rows("/data/"),
            _Table(
                {
                    "/data/open": "/data/a",
                    "/data/door": "/data/secret",
                    "/data/secret/l": "/data/a",
                    "/ghost/deep/lnk": "/data/secret",
                }
            ),
            hidden,
        ),
    )
    view = link_view(files)
    assert view is not None
    assert view.stat_at("/data/open") is not None
    assert view.stat_at("/data/door") is None
    assert view.stat_at("/data/secret/l") is None
    assert [path for path, _row in view.subtree("/data")] == ["/data/open"]
    assert view.resolve("/data/secret/l") == "/data/secret/l"
    assert await view.target_stat("/data/door") is None
    assert owed_names(files, "/data") == ["open"]
    assert owed_names(files, "/") == ["data"]


def test_a_hidden_mount_is_a_boundary_but_never_named():
    hidden = Visibility(paths=HiddenPaths(paths=("/data/secret",)))
    files = Files(
        _Dispatch(),
        readers(
            _rows("/data/", "/data/open/", "/data/secret/"), visibility=hidden
        ),
    )
    mounts = mount_view(files)
    assert mounts is not None
    assert mounts.descendants("/data") == ["/data/open", "/data/secret"]
    assert mounts.visible_descendants("/data") == ["/data/open"]
    assert mounts.root_of("/data/open/x") == "/data/open/"
    assert mounts.is_root("/data/secret")
    crossing = mount_view(files, crossing=True)
    assert crossing is not None
    assert crossing.descendants("/data") == []
    assert not crossing.is_root("/data/open")
    assert crossing.root_of("/data/open/x") == "/data/open/"


def test_a_command_in_a_mount_scope_walks_and_answers_as_that_mount():
    facts = MountRow(
        prefix="/data/",
        resource_type="ram",
        mode=MountMode.READ,
        calls=frozenset({"read_tree"}),
    )
    ctx = Context(
        vfs=Files(_Dispatch(), readers([facts, *_rows("/data/inner/")]))
    )
    across = mounts_of(ctx)
    assert across is not None and across.answers is not None
    assert (crosses_mounts(ctx), mount_root(ctx)) == (True, "")
    assert across.descendants("/data") == []
    assert not across.answers("/data/x", "read_tree")
    token = set_mount_gate("/data/", MountMode.WRITE)
    try:
        bound = mounts_of(ctx)
        assert (crosses_mounts(ctx), mount_root(ctx)) == (False, "/data")
    finally:
        reset_mount_gate(token)
    assert bound is not None and bound.answers is not None
    assert bound.descendants("/data") == ["/data/inner"]
    assert bound.answers("/data/x", "read_tree")
    assert not bound.answers("/data/x", "first_lines")
    assert (crosses_mounts(Context()), mount_root(Context())) == (False, "")
