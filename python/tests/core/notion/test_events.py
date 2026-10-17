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

import asyncio

from mirage.accessor.notion import NotionAccessor
from mirage.core.notion.client import NotionAPIError
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.events import NotionEventHook
from mirage.types import FileChangeKind, PathSpec

C, U, D, X = (
    FileChangeKind.CREATE,
    FileChangeKind.UPDATE,
    FileChangeKind.DELETE,
    FileChangeKind.UNKNOWN,
)
PLANS = "/n/pages/Plans__p1"
Q4 = f"{PLANS}/Q4__p2"
TASKS = "/n/databases/Tasks__db1/Open__ds1"
ROW = f"{TASKS}/Fix_bug__r1"


def _page(page_id: str, title: str, parent: dict) -> dict:
    return {
        "id": page_id,
        "parent": parent,
        "properties": {
            "Name": {"type": "title", "title": [{"plain_text": title}]}
        },
    }


def _objects() -> dict[str, dict]:
    return {
        "p1": _page("p1", "Plans", {"type": "workspace", "workspace": True}),
        "p2": _page("p2", "Q4", {"type": "page_id", "page_id": "p1"}),
        "p3": _page("p3", "Aside", {"type": "block_id", "block_id": "k1"}),
        "r1": _page(
            "r1",
            "Fix bug",
            {"type": "data_source_id", "data_source_id": "ds1"},
        ),
        "db1": {"id": "db1", "title": [{"plain_text": "Tasks"}]},
        "ds1": {
            "id": "ds1",
            "title": [{"plain_text": "Open"}],
            "parent": {"type": "database_id", "database_id": "db1"},
        },
    }


def _root() -> PathSpec:
    return PathSpec(virtual="/n", directory="/n", vfs_path="")


def _hook(monkeypatch) -> tuple[NotionEventHook, dict, list[str]]:
    objects = _objects()
    calls: list[str] = []

    async def fake_get(accessor, object_id):
        calls.append(object_id)
        if object_id not in objects:
            raise NotionAPIError("object_not_found", status=404)
        return dict(objects[object_id])

    for name in ("get_page", "get_database", "get_data_source"):
        monkeypatch.setattr(f"mirage.core.notion.events.{name}", fake_get)
    accessor = NotionAccessor(NotionConfig(api_key="k"))
    return NotionEventHook(accessor), objects, calls


def _event(event_type: str, entity_id: str, **data) -> dict:
    kind = event_type.split(".")[0]
    return {
        "type": event_type,
        "entity": {"id": entity_id, "type": kind},
        "data": data,
    }


def _map(hook, body) -> list[tuple[FileChangeKind, str]]:
    events = asyncio.run(hook.to_events(_root(), body["type"], body))
    return [(e.kind, e.path.virtual) for e in events]


def test_a_page_edit_updates_page_json_through_its_parents(monkeypatch):
    hook, _, calls = _hook(monkeypatch)
    found = _map(hook, _event("page.content_updated", "p2"))
    assert found == [(U, f"{Q4}/page.json")]
    _map(hook, _event("page.content_updated", "p2"))
    assert calls == ["p2", "p1"]


def test_a_row_also_updates_its_data_sources_rows(monkeypatch):
    hook, _, _ = _hook(monkeypatch)
    found = _map(
        hook,
        _event("page.properties_updated", "r1", updated_properties=["a"]),
    )
    assert found == [
        (U, f"{ROW}/page.json"),
        (U, f"{TASKS}/rows.jsonl"),
    ]
    assert _map(hook, _event("page.created", "r1")) == [
        (C, f"{ROW}/page.json"),
        (U, f"{TASKS}/rows.jsonl"),
    ]


def test_a_retitle_moves_the_directory(monkeypatch):
    hook, objects, _ = _hook(monkeypatch)
    _map(hook, _event("page.content_updated", "p2"))
    objects["p1"] = _page(
        "p1", "Ideas", {"type": "workspace", "workspace": True}
    )
    found = _map(
        hook,
        _event("page.properties_updated", "p1", updated_properties=["title"]),
    )
    assert found == [(X, PLANS), (X, "/n/pages/Ideas__p1")]
    assert _map(hook, _event("page.content_updated", "p2")) == [
        (U, "/n/pages/Ideas__p1/Q4__p2/page.json")
    ]


def test_a_retitle_of_an_unseen_page_is_unknown_on_its_parent(monkeypatch):
    hook, _, _ = _hook(monkeypatch)
    found = _map(
        hook,
        _event("page.properties_updated", "p2", updated_properties=["title"]),
    )
    assert found == [(X, PLANS)]


def test_a_move_is_unknown_where_it_was_and_where_it_is(monkeypatch):
    hook, objects, _ = _hook(monkeypatch)
    _map(hook, _event("page.content_updated", "p2"))
    objects["p2"] = _page("p2", "Q4", {"type": "workspace", "workspace": True})
    assert _map(hook, _event("page.moved", "p2")) == [
        (X, Q4),
        (X, "/n/pages/Q4__p2"),
    ]


def test_a_deleted_page_leaves_and_an_unlisted_one_maps_to_nothing(
    monkeypatch,
):
    hook, _, _ = _hook(monkeypatch)
    assert _map(hook, _event("page.deleted", "p2")) == [(D, Q4)]
    assert _map(hook, _event("page.content_updated", "p3")) == []
    assert _map(hook, _event("page.content_updated", "gone")) == []
    assert _map(hook, _event("comment.created", "p1")) == []


def test_data_sources_and_databases(monkeypatch):
    hook, _, _ = _hook(monkeypatch)
    assert _map(hook, _event("data_source.content_updated", "ds1")) == [
        (U, f"{TASKS}/rows.jsonl")
    ]
    assert _map(hook, _event("data_source.created", "ds1")) == [
        (C, f"{TASKS}/data_source.json"),
        (C, f"{TASKS}/rows.jsonl"),
        (U, "/n/databases/Tasks__db1/database.json"),
    ]
    assert _map(hook, _event("data_source.schema_updated", "ds1")) == [
        (X, TASKS),
        (U, "/n/databases/Tasks__db1/database.json"),
    ]
    assert _map(hook, _event("database.moved", "db1")) == [
        (U, "/n/databases/Tasks__db1/database.json")
    ]
    assert _map(hook, _event("database.deleted", "db1")) == [
        (D, "/n/databases/Tasks__db1")
    ]


def test_a_move_of_an_unseen_page_is_unknown_on_the_mount(monkeypatch):
    hook, _, _ = _hook(monkeypatch)
    assert _map(hook, _event("page.moved", "p2")) == [(X, "/n"), (X, Q4)]
    assert _map(hook, _event("page.moved", "r1")) == [
        (X, "/n"),
        (X, ROW),
        (U, f"{TASKS}/rows.jsonl"),
    ]
