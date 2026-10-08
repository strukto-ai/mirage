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
    LinkDoor,
    link_door,
    name_location,
    typed_link,
)
from mirage.commands.config import CommandOpts
from mirage.errors.types import DotWalkLoop
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import CycleError
from mirage.view.types import LinkView, NamespaceView


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
        children=lambda directory: [
            FileStat(name=link.rsplit("/", 1)[-1], type=FileType.SYMLINK)
            for link in table
            if link.rsplit("/", 1)[0] == directory.rstrip("/")
        ],
        subtree=lambda directory: [],
        resolve=resolve,
        exists=exists,
        target_stat=target_stat,
    )


LINKS = _links({"/data/dl": "/data/dir", "/data/dir/tl.gz": "/data/t.gz"})


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


class _Door:
    """A door that records the ops it is asked for."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    async def __call__(
        self, op: str, path: PathSpec, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        self.calls.append((op, path.virtual, kwargs))
        if op == "read":
            return b"through the door", IOResult()
        if op == "readdir":
            return (f"{path.virtual}/a", f"{path.virtual}/b"), IOResult()
        return FileStat(name="n", type=FileType.SYMLINK), IOResult()


@pytest.mark.asyncio
async def test_the_door_reads_writes_and_unlinks_by_the_name_it_is_handed():
    calls = _Door()
    door = LinkDoor(links=LINKS, dispatch=calls, cwd="/data")
    assert [c async for c in door.read("/data/dir/tl.gz")] == [
        b"through the door"
    ]
    await door.write("/data/dir/tl", b"x")
    await door.unlink("/data/dir/tl.gz")
    await door.lstat(PathSpec.from_str_path("/data/dir/tl.gz"))
    assert calls.calls == [
        ("read", "/data/dir/tl.gz", {}),
        ("write", "/data/dir/tl", {"data": b"x"}),
        ("unlink", "/data/dir/tl.gz", {}),
        ("stat", "/data/dir/tl.gz", {"nofollow": True}),
    ]


def test_a_link_the_router_followed_can_vanish_before_its_turn():
    door = LinkDoor(links=_links({}), dispatch=_Door(), cwd="/data")
    followed = _spec("/data/t.gz", "tl.gz")
    assert door.vanished(followed)
    assert door.link_at(followed) is None
    assert not door.vanished(_spec("/data/t.gz", "t.gz"))


def test_an_invocation_without_links_or_a_door_has_no_link_door():
    assert link_door(CommandOpts()) is None
    assert link_door(CommandOpts(ns=NamespaceView(links=LINKS))) is None
    door = link_door(
        CommandOpts(ns=NamespaceView(links=LINKS), dispatch=_Door())
    )
    assert door is not None and door.cwd == "/"


@pytest.mark.asyncio
async def test_the_door_lists_and_stats_by_the_name_it_is_handed():
    calls = _Door()
    door = LinkDoor(links=LINKS, dispatch=calls, cwd="/data")
    assert await door.readdir("/data/dir") == ["/data/dir/a", "/data/dir/b"]
    assert (await door.stat("/data/t.gz")).name == "n"
    assert calls.calls == [
        ("readdir", "/data/dir", {}),
        ("stat", "/data/t.gz", {}),
    ]


def test_a_walker_merges_the_links_standing_in_a_directory():
    door = LinkDoor(links=LINKS, dispatch=_Door(), cwd="/data")
    assert door.children("/data/dir/") == ["/data/dir/tl.gz"]
    assert door.children("/data/w") == []


def test_a_link_leads_where_the_table_resolves_it():
    door = LinkDoor(links=LINKS, dispatch=_Door(), cwd="/data")
    assert door.target("/data/dir/tl.gz") == "/data/t.gz"


def test_a_looping_link_is_the_eloop_a_walker_reports():
    door = LinkDoor(
        links=_links({"/data/l": "/data/l"}), dispatch=_Door(), cwd="/data"
    )
    with pytest.raises(DotWalkLoop):
        door.target("/data/l")
