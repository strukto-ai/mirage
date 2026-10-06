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

import pytest

from mirage.commands.cli.builtin.git.errors import MountInWayError
from mirage.commands.cli.builtin.git.io import (
    basename,
    blocking_ancestor,
    refuse_mount,
    remove_empty_parents,
    remove_tree,
)
from mirage.ops.types import MountView
from mirage.types import FileStat, FileType, PathSpec

REPO = PathSpec.from_str_path("/repo")
SLOT = PathSpec.from_str_path("/repo/slot")


@pytest.mark.parametrize(
    "entry", ["pack", "pack/", "/repo/.git/objects/pack", "objects/pack//"]
)
def test_basename_is_the_final_segment_of_any_entry_spelling(entry):
    assert basename(entry) == "pack"


class Links:
    """A link view holding one link, at ``/repo/slot``."""

    def stat_at(self, path: str) -> FileStat | None:
        """What the namespace holds at a path, None when no link.

        Args:
            path (str): absolute virtual path.
        """
        if path != "/repo/slot":
            return None
        return FileStat(name="slot", type=FileType.SYMLINK)


async def only_dirs(path: PathSpec) -> FileStat | None:
    """A data plane in which every component is a directory.

    Args:
        path (PathSpec): absolute virtual path.
    """
    return FileStat(
        name=path.virtual.rsplit("/", 1)[-1], type=FileType.DIRECTORY
    )


async def file_at_slot(path: PathSpec) -> FileStat | None:
    """A data plane holding a regular file at ``/repo/slot``.

    Args:
        path (PathSpec): absolute virtual path.
    """
    kind = (
        FileType.FILE if path.virtual == "/repo/slot" else FileType.DIRECTORY
    )
    return FileStat(name=path.virtual.rsplit("/", 1)[-1], type=kind)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stat_path, name, links, expected",
    [
        (only_dirs, "slot/child", Links(), "/repo/slot"),
        # The component itself is not an ancestor of itself, and a path
        # with nothing but directories above it has none.
        (only_dirs, "slot", Links(), None),
        (only_dirs, "other/child", Links(), None),
        # No link anywhere: what is in the way is an ordinary file, which
        # only the data plane can report.
        (file_at_slot, "slot/child", None, "/repo/slot"),
        (only_dirs, "slot/child", None, None),
        # stat_path dereferences, so a link to a directory stats as a
        # directory: asking it first would walk straight through the link.
        (only_dirs, "slot/deep/child", Links(), "/repo/slot"),
    ],
)
async def test_blocking_ancestor(stat_path, name, links, expected):
    found = await blocking_ancestor(stat_path, REPO, name, links)
    assert (None if found is None else found.virtual) == expected


class TreeLinks:
    """A link view holding one link, at ``/repo/slot/link``."""

    def stat_at(self, path: str) -> FileStat | None:
        """What the namespace holds at a path, None when no link.

        Args:
            path (str): absolute virtual path.
        """
        if path != "/repo/slot/link":
            return None
        return FileStat(name="link", type=FileType.SYMLINK)


class Recorder:
    """A dispatcher that lists one link and records every op it is asked for.

    ``readdir`` answers through the link the way the real one does: the
    name plane owns links, so the data plane resolves the path and
    lists what it points at.
    """

    def __init__(self) -> None:
        self.ops: list[tuple[str, str]] = []

    async def __call__(self, op: str, path, **kwargs):
        """Record one op and answer the listings.

        Args:
            op (str): the op name.
            path (PathSpec): the path it is asked for.
            **kwargs (object): ignored.
        """
        where = path.virtual
        self.ops.append((op, where))
        if op == "readdir":
            if where == "/repo/slot":
                return ["/repo/slot/link"], None
            if where == "/repo/slot/link":
                return ["/repo/outside/keep.txt"], None
            return [], None
        if op == "rmdir" and where != "/repo/slot":
            raise NotADirectoryError(where)
        return None, None


@pytest.mark.asyncio
async def test_removing_a_tree_unlinks_a_link_without_descending():
    calls = Recorder()
    await remove_tree(calls, SLOT, TreeLinks(), None)
    assert ("unlink", "/repo/slot/link") in calls.ops
    # The whole point: readdir dereferences, so listing the link at all
    # is the walk stepping outside the directory being replaced.
    assert ("readdir", "/repo/slot/link") not in calls.ops
    assert not any(
        where.startswith("/repo/outside") for _op, where in calls.ops
    )


@pytest.mark.asyncio
async def test_without_a_namespace_the_walk_has_nothing_to_ask():
    # Outside a workspace there is no name plane, so a link cannot be
    # told from a directory and the walk is the old one.
    calls = Recorder()
    await remove_tree(calls, SLOT, None, None)
    assert ("readdir", "/repo/slot/link") in calls.ops


def mounts(roots: list[str], hidden: list[str] | None = None) -> MountView:
    """A mount view over a fixed list of roots.

    Args:
        roots (list[str]): every mount root, without a trailing slash.
        hidden (list[str] | None): the ones this session may not be
            told about, a subset of ``roots``.
    """
    unseen = set(hidden or [])
    return MountView(
        descendants=lambda path: [
            root for root in roots if root.startswith(f"{path}/")
        ],
        visible_descendants=lambda path: [
            root
            for root in roots
            if root.startswith(f"{path}/") and root not in unseen
        ],
        is_root=lambda path: path in roots,
        root_of=lambda path: None,
    )


def test_a_mount_root_is_refused_as_itself():
    with pytest.raises(MountInWayError) as caught:
        refuse_mount(mounts(["/repo/slot"]), SLOT)
    assert str(caught.value) == (
        "cannot remove '/repo/slot': it is a mount root"
    )


def test_a_nested_mount_is_named():
    with pytest.raises(MountInWayError) as caught:
        refuse_mount(mounts(["/repo/slot/data"]), SLOT)
    assert str(caught.value) == (
        "cannot remove '/repo/slot': '/repo/slot/data' is a mount root"
    )


def test_the_first_nested_mount_in_order_is_the_one_named():
    with pytest.raises(MountInWayError) as caught:
        refuse_mount(mounts(["/repo/slot/z", "/repo/slot/a"]), SLOT)
    assert "'/repo/slot/a'" in str(caught.value)


def test_a_hidden_mount_blocks_the_removal_without_being_named():
    # Avoiding a boundary and naming one are two different questions,
    # and a hidden mount's name is what the hide exists to withhold.
    view = mounts(["/repo/slot/data"], hidden=["/repo/slot/data"])
    with pytest.raises(MountInWayError) as caught:
        refuse_mount(view, SLOT)
    assert str(caught.value) == (
        "cannot remove '/repo/slot': it holds a mount root"
    )


def test_nothing_in_the_way_is_no_refusal():
    refuse_mount(mounts(["/other/mount"]), SLOT)
    refuse_mount(None, SLOT)


@pytest.mark.asyncio
async def test_a_tree_holding_a_mount_is_refused_before_anything_is_deleted():
    calls = Recorder()
    with pytest.raises(MountInWayError):
        await remove_tree(
            calls, SLOT, TreeLinks(), mounts(["/repo/slot/data"])
        )
    # Nothing at all: the refusal is the first thing the walk does, so
    # the directory is still whole when the caller hears about it.
    assert calls.ops == []


class Parents:
    """A dispatcher whose directories are all empty."""

    def __init__(self) -> None:
        self.ops: list[tuple[str, str]] = []

    async def __call__(self, op: str, path, **kwargs):
        """Record one op and answer an empty listing.

        Args:
            op (str): the op name.
            path (PathSpec): the path it is asked for.
            **kwargs (object): ignored.
        """
        self.ops.append((op, path.virtual))
        if op == "readdir":
            return [], None
        return None, None


@pytest.mark.asyncio
async def test_pruning_empty_parents_stops_at_a_mount_root():
    calls = Parents()
    await remove_empty_parents(
        calls,
        PathSpec.from_str_path("/repo/slot/data/x.txt"),
        REPO,
        mounts(["/repo/slot/data"]),
    )
    assert ("rmdir", "/repo/slot/data") not in calls.ops
    # And it stops rather than skipping: the directories above the
    # mount are the mount's parents, not git's to tidy either.
    assert ("rmdir", "/repo/slot") not in calls.ops


@pytest.mark.asyncio
async def test_pruning_empty_parents_takes_an_ordinary_directory():
    calls = Parents()
    await remove_empty_parents(
        calls,
        PathSpec.from_str_path("/repo/docs/x.txt"),
        REPO,
        mounts(["/repo/slot/data"]),
    )
    assert ("rmdir", "/repo/docs") in calls.ops
