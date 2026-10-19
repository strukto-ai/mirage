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
    blocking_ancestor,
    refuse_mount,
    remove_empty_parents,
    remove_tree,
)
from mirage.types import FileStat, FileType, MountMode, PathSpec, Visibility
from mirage.utils.hidden import classify_paths
from mirage.workspace.files import Files
from mirage.workspace.types import MountRow
from tests.fixtures.readers import readers

REPO = PathSpec.from_str_path("/repo")
SLOT = PathSpec.from_str_path("/repo/slot")


def files(
    dispatch,
    roots: list[str] | None = None,
    hidden: list[str] | None = None,
) -> Files:
    """The session's files over a fake dispatcher and a mount table.

    Args:
        dispatch (DispatchFn): the fake answering every call.
        roots (list[str] | None): mount roots below ``/``, without a
            trailing slash.
        hidden (list[str] | None): paths the session hides.
    """
    rows = [
        MountRow(
            prefix=f"{root.rstrip('/')}/",
            resource_type="ram",
            mode=MountMode.WRITE,
        )
        for root in ["/", *(roots or [])]
    ]
    vis = Visibility(paths=classify_paths(hidden)) if hidden else None
    return Files(dispatch, readers(rows, visibility=vis))


def stats(kind, links: set[str]):
    """A dispatcher whose stat answers ``kind`` and whose lstat reports
    ``links`` as symlinks.

    Args:
        kind (Callable[[PathSpec], FileType]): what a followed stat sees.
        links (set[str]): paths holding a symlink.
    """

    async def dispatch(op: str, path: PathSpec, **kwargs):
        assert op == "stat", op
        name = path.virtual.rsplit("/", 1)[-1]
        if kwargs.get("nofollow") and path.virtual in links:
            return FileStat(name=name, type=FileType.SYMLINK), None
        return FileStat(name=name, type=kind(path)), None

    return dispatch


def only_dirs(path: PathSpec) -> FileType:
    """A data plane in which every component is a directory.

    Args:
        path (PathSpec): absolute virtual path.
    """
    return FileType.DIRECTORY


def file_at_slot(path: PathSpec) -> FileType:
    """A data plane holding a regular file at ``/repo/slot``.

    Args:
        path (PathSpec): absolute virtual path.
    """
    return (
        FileType.FILE if path.virtual == "/repo/slot" else FileType.DIRECTORY
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind, name, links, expected",
    [
        (only_dirs, "slot/child", {"/repo/slot"}, "/repo/slot"),
        # The component itself is not an ancestor of itself, and a path
        # with nothing but directories above it has none.
        (only_dirs, "slot", {"/repo/slot"}, None),
        (only_dirs, "other/child", {"/repo/slot"}, None),
        # No link anywhere: what is in the way is an ordinary file, which
        # only the stat can report.
        (file_at_slot, "slot/child", set(), "/repo/slot"),
        (only_dirs, "slot/child", set(), None),
        # stat dereferences, so a link to a directory stats as a
        # directory: asking it first would walk straight through the link.
        (only_dirs, "slot/deep/child", {"/repo/slot"}, "/repo/slot"),
    ],
)
async def test_blocking_ancestor(kind, name, links, expected):
    found = await blocking_ancestor(files(stats(kind, links)), REPO, name)
    assert (None if found is None else found.virtual) == expected


class Recorder:
    """A dispatcher that lists one link and records every op it is asked for.

    ``readdir`` answers through the link the way the real one does, so
    listing the link lists what it points at.
    """

    def __init__(self) -> None:
        self.ops: list[tuple[str, str]] = []

    async def __call__(self, op: str, path, **kwargs):
        """Record one op and answer the listings.

        Args:
            op (str): the op name.
            path (PathSpec): the path it is asked for.
            **kwargs (object): the call's arguments.
        """
        where = path.virtual
        self.ops.append((op, where))
        if op == "stat":
            name = where.rsplit("/", 1)[-1]
            if kwargs.get("nofollow") and where == "/repo/slot/link":
                return FileStat(name=name, type=FileType.SYMLINK), None
            return FileStat(name=name, type=FileType.DIRECTORY), None
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
    await remove_tree(files(calls), SLOT)
    assert ("unlink", "/repo/slot/link") in calls.ops
    # The whole point: readdir dereferences, so listing the link at all
    # is the walk stepping outside the directory being replaced.
    assert ("readdir", "/repo/slot/link") not in calls.ops
    assert not any(
        where.startswith("/repo/outside") for _op, where in calls.ops
    )


def test_a_mount_root_is_refused_as_itself():
    with pytest.raises(MountInWayError) as caught:
        refuse_mount(files(Recorder(), ["/repo/slot"]), SLOT)
    assert str(caught.value) == (
        "cannot remove '/repo/slot': it is a mount root"
    )


def test_a_nested_mount_is_named():
    with pytest.raises(MountInWayError) as caught:
        refuse_mount(files(Recorder(), ["/repo/slot/data"]), SLOT)
    assert str(caught.value) == (
        "cannot remove '/repo/slot': '/repo/slot/data' is a mount root"
    )


def test_the_first_nested_mount_in_order_is_the_one_named():
    with pytest.raises(MountInWayError) as caught:
        refuse_mount(files(Recorder(), ["/repo/slot/z", "/repo/slot/a"]), SLOT)
    assert "'/repo/slot/a'" in str(caught.value)


def test_a_hidden_mount_blocks_the_removal_without_being_named():
    # Avoiding a boundary and naming one are two different questions,
    # and a hidden mount's name is what the hide exists to withhold.
    view = files(Recorder(), ["/repo/slot/data"], hidden=["/repo/slot/data"])
    with pytest.raises(MountInWayError) as caught:
        refuse_mount(view, SLOT)
    assert str(caught.value) == (
        "cannot remove '/repo/slot': it holds a mount root"
    )


def test_a_hidden_mount_deeper_down_is_not_named_either():
    view = files(
        Recorder(), ["/repo/slot/a/data"], hidden=["/repo/slot/a/data"]
    )
    with pytest.raises(MountInWayError) as caught:
        refuse_mount(view, REPO)
    assert str(caught.value) == "cannot remove '/repo': it holds a mount root"


def test_nothing_in_the_way_is_no_refusal():
    refuse_mount(files(Recorder(), ["/other/mount"]), SLOT)


@pytest.mark.asyncio
async def test_a_tree_holding_a_mount_is_refused_before_anything_is_deleted():
    calls = Recorder()
    with pytest.raises(MountInWayError):
        await remove_tree(files(calls, ["/repo/slot/data"]), SLOT)
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
        files(calls, ["/repo/slot/data"]),
        PathSpec.from_str_path("/repo/slot/data/x.txt"),
        REPO,
    )
    assert ("rmdir", "/repo/slot/data") not in calls.ops
    # And it stops rather than skipping: the directories above the
    # mount are the mount's parents, not git's to tidy either.
    assert ("rmdir", "/repo/slot") not in calls.ops


@pytest.mark.asyncio
async def test_pruning_empty_parents_takes_an_ordinary_directory():
    calls = Parents()
    await remove_empty_parents(
        files(calls, ["/repo/slot/data"]),
        PathSpec.from_str_path("/repo/docs/x.txt"),
        REPO,
    )
    assert ("rmdir", "/repo/docs") in calls.ops
