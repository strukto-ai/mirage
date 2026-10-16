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
    link_resolver,
    link_view,
    mount_view,
    name_location,
    owed_names,
    typed_link,
)
from mirage.commands.config import CommandOpts
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
        ("read", "/data/dir/tl.gz", {}),
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


def test_an_invocation_without_links_or_an_entry_point_has_no_link_resolver():
    files = Files([], _Dispatch(), links=_Table({}))
    assert link_resolver(CommandOpts()) is None
    assert link_resolver(CommandOpts(vfs=files)) is None
    resolver = link_resolver(CommandOpts(vfs=files, dispatch=_Dispatch()))
    assert resolver is not None and resolver.cwd == "/"


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
    files = Files(_rows("/base/", "/base/inner/", "/dev/"), _Dispatch())
    assert owed_names(files, "/base") == ["inner"]
    assert owed_names(files, "/") == ["base", "dev"]
    assert owed_names(files, "/dev") == []


def test_owed_names_include_link_ancestors():
    # A link below a directory chain no backend serves synthesizes its
    # ancestors, exactly as a nested mount prefix does, so `ls /` shows
    # the way to it.
    files = Files(
        _rows("/base/"),
        _Dispatch(),
        links=_Table({"/ghost/deep/lnk": "/base"}),
    )
    assert owed_names(files, "/") == ["base", "ghost"]
    assert owed_names(files, "/ghost") == ["deep"]
    assert owed_names(None, "/") == []


def test_a_link_view_is_live_whenever_the_files_hold_a_table():
    table = _Table({})
    view = link_view(Files([], _Dispatch(), links=table))
    assert view is not None
    assert view.subtree("/") == []
    table._targets["/data/l"] = "/data/a"
    assert view.stat_at("/data/l") is not None
    assert link_view(Files([], _Dispatch())) is None
    assert link_view(None) is None


def test_a_hidden_mount_is_a_boundary_but_never_named():
    hidden = Visibility(paths=HiddenPaths(paths=("/data/secret",)))
    files = Files(
        _rows("/data/", "/data/open/", "/data/secret/"),
        _Dispatch(),
        visibility=lambda _session: hidden,
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
