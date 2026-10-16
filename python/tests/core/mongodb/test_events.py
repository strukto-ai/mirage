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

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.core.mongodb.events import MongoDBEventHook
from mirage.types import FileChangeKind, JsonValue, PathSpec

ROOT = PathSpec.from_str_path("/m", vfs_path="")
U, C, D = FileChangeKind.UPDATE, FileChangeKind.CREATE, FileChangeKind.DELETE


def _hook(databases: list[str] | None = None) -> MongoDBEventHook:
    accessor = MagicMock()
    accessor.config.databases = databases
    return MongoDBEventHook(accessor)


def _event(
    kind: str, coll: str = "books", db: str = "lib", **extra: JsonValue
) -> dict[str, JsonValue]:
    return {"operationType": kind, "ns": {"db": db, "coll": coll}, **extra}


@pytest.mark.asyncio
async def test_events_name_the_files_they_change():
    # A write rewrites the documents and the schema sampled from them,
    # and both files of each view; a collection created, renamed or
    # dropped is its directory and its database's database.json. The
    # views are listed once, and again after an event that changes them.
    views = AsyncMock(return_value=["recent"])
    hook = _hook(["lib"])
    steps = [
        _event("insert", "books"),
        _event("update", "books"),
        _event("create", "recent", operationDescription={"viewOn": "books"}),
        _event(
            "modify",
            "recent",
            operationDescription={"viewOn": "books", "pipeline": []},
        ),
        _event("createIndexes", "books"),
        _event("rename", "old", to={"db": "lib", "coll": "new"}),
        _event("delete", "books"),
        _event("insert", "hidden", db="admin"),
        _event("insert", "logs", db="other"),
    ]
    with patch("mirage.core.mongodb.events.list_collections", views):
        got = [
            [
                (e.kind, e.path.virtual)
                for e in await hook.to_events(ROOT, str(s["operationType"]), s)
            ]
            for s in steps
        ]
    written = [
        (U, "/m/lib/collections/books/documents.jsonl"),
        (U, "/m/lib/collections/books/schema.json"),
        (U, "/m/lib/views/recent/documents.jsonl"),
        (U, "/m/lib/views/recent/schema.json"),
    ]
    assert got == [
        written,
        written,
        [(C, "/m/lib/views/recent"), (U, "/m/lib/database.json")],
        [
            (U, "/m/lib/views/recent/schema.json"),
            (U, "/m/lib/views/recent/documents.jsonl"),
        ],
        [(U, "/m/lib/collections/books/schema.json")],
        [
            (D, "/m/lib/collections/old"),
            (U, "/m/lib/database.json"),
            (C, "/m/lib/collections/new"),
        ],
        written,
        [],
        [],
    ]
    assert views.await_count == 2


@pytest.mark.asyncio
async def test_a_dropped_database_leaves_and_an_invalidated_stream_is_unknown():
    hook = _hook()
    dropped = await hook.to_events(ROOT, "dropDatabase", {"ns": {"db": "lib"}})
    invalid = await hook.to_events(ROOT, "invalidate", {})
    assert [(e.kind, e.path.virtual) for e in [*dropped, *invalid]] == [
        (D, "/m/lib"),
        (FileChangeKind.UNKNOWN, "/m"),
    ]
