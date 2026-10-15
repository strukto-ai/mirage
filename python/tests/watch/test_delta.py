from datetime import datetime, timezone

import pytest

from mirage.types import FileChangeKind, PathSpec
from mirage.watch.delta import changes_under, folder_path, moved_below, settle


def test_settle_names_each_move_by_where_the_item_was():
    changes: list[tuple[FileChangeKind, str]] = []
    seen = {"dir": "/m/old", "f": "/m/old/f.txt", "g": "/m/g.txt"}
    settle(changes, seen, "new", "/m/new.txt", True)
    settle(changes, seen, "edited", "/m/e.txt", False)
    settle(changes, seen, "g", "/m/g.txt", False)
    was = settle(changes, seen, "dir", "/m/renamed", False)
    assert was is not None
    moved_below(seen, was, "/m/renamed")
    settle(changes, seen, "unseen", None, False)
    assert changes == [
        (FileChangeKind.CREATE, "/m/new.txt"),
        (FileChangeKind.UPDATE, "/m/e.txt"),
        (FileChangeKind.UPDATE, "/m/g.txt"),
        (FileChangeKind.DELETE, "/m/old"),
        (FileChangeKind.CREATE, "/m/renamed"),
    ]
    assert seen["f"] == "/m/renamed/f.txt"


@pytest.mark.asyncio
async def test_folder_path_climbs_to_the_top_and_keeps_what_it_looked_up():
    fetched = {"b": ["B", "a"], "x": ["X", ""]}

    async def look_up(folder_id: str) -> list[str] | None:
        return fetched.get(folder_id)

    folders = {"a": ["A", "top"]}
    assert await folder_path("b", "top", folders, look_up) == "A/B"
    assert await folder_path("top", "top", folders, look_up) == ""
    assert await folder_path("x", "top", folders, look_up) is None
    assert await folder_path("gone", "top", folders, look_up) is None
    assert folders == {"a": ["A", "top"], "b": ["B", "a"], "x": ["X", ""]}


def test_changes_under_a_root_name_it_when_a_parent_moves():
    # A change below the root is itself; one at a parent is the root's:
    # the parent removed removes it, anything else may have moved it.
    root = PathSpec.from_str_path("/m/a/b/f.txt", vfs_path="a/b/f.txt")
    at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    events = changes_under(
        root,
        [
            (FileChangeKind.UPDATE, "/m/a/b/f.txt"),
            (FileChangeKind.UPDATE, "/m/a/c.txt"),
            (FileChangeKind.DELETE, "/m/a/b"),
            (FileChangeKind.CREATE, "/m/a"),
        ],
        at,
    )
    assert [(e.kind, e.path.virtual, e.path.vfs_path) for e in events] == [
        (FileChangeKind.UPDATE, "/m/a/b/f.txt", "a/b/f.txt"),
        (FileChangeKind.DELETE, "/m/a/b/f.txt", "a/b/f.txt"),
        (FileChangeKind.UNKNOWN, "/m/a/b/f.txt", "a/b/f.txt"),
    ]
