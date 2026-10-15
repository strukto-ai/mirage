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

import json
from unittest.mock import patch

import pytest

from mirage.accessor.box import BoxAccessor
from mirage.core.box.client import BoxTokenManager
from mirage.core.box.watch import BoxDeltaHook, BoxEventHook
from mirage.types import FileChangeKind, PathSpec
from mirage.vfs.box.config import BoxConfig

ALL_FILES = {"type": "folder", "id": "0", "name": "All Files"}
TEAM = {"type": "folder", "id": "10", "name": "team"}
TRASH = {"type": "folder", "id": "1", "name": "Trash"}


def _accessor(root_folder_id: str | None = None) -> BoxAccessor:
    config = BoxConfig(access_token="t", root_folder_id=root_folder_id)
    return BoxAccessor(config, BoxTokenManager(config))


def _root(vfs_path: str = "") -> PathSpec:
    virtual = "/box/" + vfs_path if vfs_path else "/box"
    return PathSpec(virtual=virtual, directory=virtual, vfs_path=vfs_path)


def _file(box_id: str, name: str, sha1: str, *parents: dict) -> dict:
    return {
        "type": "file",
        "id": box_id,
        "name": name,
        "sha1": sha1,
        "size": 4,
        "modified_at": "2026-09-20T10:00:00-07:00",
        "path_collection": {
            "total_count": len(parents) + 1,
            "entries": [ALL_FILES, *parents],
        },
    }


def _folder(box_id: str, name: str, *parents: dict) -> dict:
    return {
        "type": "folder",
        "id": box_id,
        "name": name,
        "path_collection": {
            "total_count": len(parents) + 1,
            "entries": [ALL_FILES, *parents],
        },
    }


def _trashed(item: dict) -> dict:
    return {**item, "path_collection": {"total_count": 1, "entries": [TRASH]}}


def _event(
    event_type: str, source: dict, event_id: str = "", created_at: str = ""
) -> dict:
    event = {
        "type": "event",
        "event_id": event_id or f"{event_type}-{source['id']}",
        "event_type": event_type,
        "source": source,
    }
    if created_at:
        event["created_at"] = created_at
    return event


class FakeBox:
    """A queue of pending user events behind a stream position."""

    def __init__(self) -> None:
        self.pending: list[dict] = []
        self.position = 100
        self.calls: list[str] = []

    async def events_now(self, tm, stream_type: str) -> str:
        self.calls.append("now")
        return str(self.position)

    async def events_since(self, tm, position: str, stream_type: str):
        self.calls.append(f"since {position}")
        found, self.pending = self.pending, []
        self.position += len(found)
        return found, str(self.position)


async def _pull(
    fake: FakeBox, hook: BoxDeltaHook, root: PathSpec, checkpoint: str | None
):
    with (
        patch("mirage.core.box.watch.events_now", fake.events_now),
        patch("mirage.core.box.watch.events_since", fake.events_since),
    ):
        return await hook.pull(root, checkpoint)


def _kinds(delta) -> set[tuple[str, FileChangeKind]]:
    return {(c.path.virtual, c.kind) for c in delta.changes}


@pytest.mark.asyncio
async def test_baseline_takes_the_stream_head_and_lists_nothing() -> None:
    fake = FakeBox()
    delta = await _pull(fake, BoxDeltaHook(_accessor()), _root(), None)
    assert delta.changes == ()
    assert fake.calls == ["now"]


@pytest.mark.asyncio
async def test_each_ping_maps_the_events_since_the_last_position() -> None:
    # The places an event names are remembered in the checkpoint, so a
    # later pull follows an item it saw: an upload of a known file is an
    # UPDATE, its rename a MOVE, and its trash a DELETE where it was.
    fake = FakeBox()
    hook = BoxDeltaHook(_accessor("10"))
    root = _root()
    a = _file("1", "a.txt", "s1", TEAM)
    steps = [
        [_event("ITEM_UPLOAD", a)],
        [_event("ITEM_UPLOAD", a, "e2")],
        [_event("ITEM_RENAME", {**a, "name": "b.txt"})],
        [_event("ITEM_TRASH", _trashed({**a, "name": "b.txt"}))],
    ]
    delta = await _pull(fake, hook, root, None)
    got = []
    for events in steps:
        fake.pending = events
        delta = await _pull(fake, hook, root, delta.checkpoint)
        got.append([(c.kind, c.path.virtual) for c in delta.changes])
    assert got == [
        [(FileChangeKind.CREATE, "/box/a.txt")],
        [(FileChangeKind.UPDATE, "/box/a.txt")],
        [(FileChangeKind.MOVE, "/box/b.txt")],
        [(FileChangeKind.DELETE, "/box/b.txt")],
    ]
    assert "list" not in " ".join(fake.calls)


@pytest.mark.asyncio
async def test_a_move_out_of_the_watch_root_is_a_delete_where_it_was() -> None:
    fake = FakeBox()
    hook = BoxDeltaHook(_accessor("10"))
    root = _root("sub")
    sub = {"type": "folder", "id": "20", "name": "sub"}
    a = _file("1", "a.txt", "s1", TEAM, sub)
    delta = await _pull(fake, hook, root, None)
    fake.pending = [_event("ITEM_UPLOAD", a)]
    delta = await _pull(fake, hook, root, delta.checkpoint)
    fake.pending = [_event("ITEM_MOVE", _file("1", "a.txt", "s1", TEAM))]
    delta = await _pull(fake, hook, root, delta.checkpoint)
    assert _kinds(delta) == {("/box/sub/a.txt", FileChangeKind.DELETE)}


@pytest.mark.asyncio
async def test_events_apply_once_each_in_the_order_they_happened() -> None:
    fake = FakeBox()
    hook = BoxDeltaHook(_accessor("10"))
    a = _file("1", "a.txt", "s1", TEAM)
    delta = await _pull(fake, hook, _root(), None)
    fake.pending = [
        _event(
            "ITEM_RENAME", {**a, "name": "b.txt"}, "e2", "2026-09-20T10:00:02Z"
        ),
        _event("ITEM_UPLOAD", a, "e1", "2026-09-20T10:00:01Z"),
        _event("ITEM_UPLOAD", a, "e1", "2026-09-20T10:00:01Z"),
    ]
    delta = await _pull(fake, hook, _root(), delta.checkpoint)
    assert [(c.kind, c.path.virtual) for c in delta.changes] == [
        (FileChangeKind.CREATE, "/box/a.txt"),
        (FileChangeKind.MOVE, "/box/b.txt"),
    ]


@pytest.mark.asyncio
async def test_a_position_older_than_the_replay_window_is_unknown() -> None:
    # Box replays whatever it still keeps from a stale position, so the
    # root is UNKNOWN and the stream starts again at the present.
    fake = FakeBox()
    hook = BoxDeltaHook(_accessor())
    delta = await _pull(fake, hook, _root(), None)
    state = json.loads(delta.checkpoint or "")
    state["box"]["read"] = "2020-01-01T00:00:00+00:00"
    fake.pending = [_event("ITEM_UPLOAD", _file("1", "a.txt", "s1", TEAM))]
    stale = await _pull(fake, hook, _root(), json.dumps(state))
    assert _kinds(stale) == {("/box", FileChangeKind.UNKNOWN)}
    assert fake.calls == ["now", "now"]


async def _mapped(hook: BoxEventHook, event_type: str, source: dict):
    out = await hook.to_events(_root(), event_type, _event(event_type, source))
    return [
        (
            c.kind,
            c.path.virtual,
            c.previous_path.virtual if c.previous_path else None,
        )
        for c in out
    ]


@pytest.mark.asyncio
async def test_event_hook_tracks_ids_across_events() -> None:
    hook = BoxEventHook(_accessor())
    assert await _mapped(hook, "ITEM_UPLOAD", _file("1", "a.txt", "s1")) == [
        (FileChangeKind.CREATE, "/box/a.txt", None)
    ]
    assert await _mapped(hook, "ITEM_UPLOAD", _file("1", "a.txt", "s2")) == [
        (FileChangeKind.UPDATE, "/box/a.txt", None)
    ]
    assert await _mapped(hook, "ITEM_RENAME", _file("1", "b.txt", "s2")) == [
        (FileChangeKind.MOVE, "/box/b.txt", "/box/a.txt")
    ]
    assert await _mapped(
        hook, "ITEM_TRASH", _trashed(_file("1", "b.txt", "s2"))
    ) == [(FileChangeKind.DELETE, "/box/b.txt", None)]


@pytest.mark.asyncio
async def test_event_hook_move_of_unknown_item_is_unknown_on_parent() -> None:
    hook = BoxEventHook(_accessor())
    assert await _mapped(
        hook, "ITEM_MOVE", _file("7", "a.txt", "s7", TEAM)
    ) == [(FileChangeKind.UNKNOWN, "/box/team", None)]


@pytest.mark.asyncio
async def test_event_hook_ignores_items_outside_the_mount() -> None:
    hook = BoxEventHook(_accessor("10"))
    elsewhere = {"type": "folder", "id": "11", "name": "other"}
    assert (
        await _mapped(
            hook, "ITEM_UPLOAD", _file("5", "n.txt", "s5", elsewhere)
        )
        == []
    )
    assert await _mapped(
        hook, "ITEM_UPLOAD", _file("6", "m.txt", "s6", TEAM)
    ) == [(FileChangeKind.CREATE, "/box/m.txt", None)]


@pytest.mark.asyncio
async def test_event_hook_folder_places_are_unknown() -> None:
    hook = BoxEventHook(_accessor())
    assert await _mapped(hook, "ITEM_CREATE", _folder("10", "team")) == [
        (FileChangeKind.CREATE, "/box/team", None)
    ]
    assert await _mapped(hook, "ITEM_COPY", _folder("20", "copy")) == [
        (FileChangeKind.UNKNOWN, "/box/copy", None)
    ]
    assert await _mapped(hook, "ITEM_RENAME", _folder("10", "crew")) == [
        (FileChangeKind.UNKNOWN, "/box/team", None),
        (FileChangeKind.UNKNOWN, "/box/crew", None),
    ]
    assert await _mapped(
        hook, "ITEM_TRASH", _trashed(_folder("10", "crew"))
    ) == [(FileChangeKind.UNKNOWN, "/box/crew", None)]


@pytest.mark.asyncio
async def test_event_hook_moves_and_forgets_what_a_folder_holds() -> None:
    hook = BoxEventHook(_accessor())
    crew = {"type": "folder", "id": "10", "name": "crew"}
    await _mapped(hook, "ITEM_CREATE", _folder("10", "team"))
    await _mapped(hook, "ITEM_UPLOAD", _file("1", "a.txt", "s1", TEAM))
    await _mapped(hook, "ITEM_UPLOAD", _file("2", "b.txt", "s2", TEAM))
    await _mapped(hook, "ITEM_RENAME", _folder("10", "crew"))
    assert await _mapped(
        hook, "ITEM_TRASH", _trashed(_file("1", "a.txt", "s1"))
    ) == [(FileChangeKind.DELETE, "/box/crew/a.txt", None)]
    assert await _mapped(
        hook, "ITEM_UPLOAD", _file("2", "b.txt", "s3", crew)
    ) == [(FileChangeKind.UPDATE, "/box/crew/b.txt", None)]
    await _mapped(hook, "ITEM_TRASH", _trashed(_folder("10", "crew")))
    assert (
        await _mapped(hook, "ITEM_TRASH", _trashed(_file("2", "b.txt", "s3")))
        == []
    )


@pytest.mark.asyncio
async def test_event_hook_mount_root_trash_is_unknown_on_the_mount() -> None:
    hook = BoxEventHook(_accessor("10"))
    assert await _mapped(
        hook, "ITEM_TRASH", _trashed(_folder("10", "team"))
    ) == [(FileChangeKind.UNKNOWN, "/box", None)]
    assert await _mapped(hook, "ITEM_RENAME", _folder("10", "crew")) == []
