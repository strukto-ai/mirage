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
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pymongo.errors import OperationFailure

from mirage.core.mongodb.types import CHANGE_STREAM_UNSUPPORTED, HISTORY_LOST
from mirage.core.mongodb.watch import build_delta_hook
from mirage.errors.types import OperationNotSupportedError
from mirage.types import FileChangeKind, PathSpec

ROOT = PathSpec.from_str_path("/m", vfs_path="")
TOKEN = {"_data": "8201"}
NEXT = {"_data": "8202"}


def _hook(databases=None):
    accessor = MagicMock()
    accessor.config.databases = databases
    return build_delta_hook(accessor)


def _event(kind: str, coll: str = "books", db: str = "lib", **extra):
    return {"operationType": kind, "ns": {"db": db, "coll": coll}, **extra}


@pytest.mark.asyncio
async def test_a_baseline_marks_the_stream_and_reports_nothing():
    drain = AsyncMock(return_value=([], TOKEN))
    with patch("mirage.core.mongodb.watch.drain_changes", drain):
        delta = await _hook().pull(ROOT, None)
    assert delta.changes == ()
    assert json.loads(delta.checkpoint) == {"mongodb": TOKEN}
    assert drain.await_args.args[1:] == (None, None)


@pytest.mark.asyncio
async def test_events_name_the_files_they_change():
    events = [
        _event("create", "books"),
        _event("insert", "books"),
        _event("update", "books"),
        _event("create", "recent", operationDescription={"viewOn": "books"}),
        _event("createIndexes", "books"),
        _event(
            "modify",
            "recent",
            operationDescription={"viewOn": "books", "pipeline": []},
        ),
        _event("insert", "old"),
        _event("rename", "old", to={"db": "lib", "coll": "new"}),
        _event("insert", "hidden", db="admin"),
        _event("insert", "logs", db="other"),
    ]
    with (
        patch(
            "mirage.core.mongodb.watch.drain_changes",
            AsyncMock(return_value=(events, NEXT)),
        ),
        patch(
            "mirage.core.mongodb.watch.list_collections",
            AsyncMock(return_value=["recent"]),
        ),
    ):
        delta = await _hook(databases=["lib"]).pull(
            ROOT, json.dumps({"mongodb": TOKEN})
        )
    assert [(c.kind, c.path.virtual) for c in delta.changes] == [
        (FileChangeKind.CREATE, "/m/lib/collections/books"),
        (FileChangeKind.UPDATE, "/m/lib/collections/books/documents.jsonl"),
        (FileChangeKind.CREATE, "/m/lib/views/recent"),
        (FileChangeKind.UPDATE, "/m/lib/collections/books/schema.json"),
        (FileChangeKind.UPDATE, "/m/lib/views/recent/schema.json"),
        (FileChangeKind.UPDATE, "/m/lib/views/recent/documents.jsonl"),
        (FileChangeKind.DELETE, "/m/lib/collections/old"),
        (FileChangeKind.CREATE, "/m/lib/collections/new"),
    ]
    assert json.loads(delta.checkpoint) == {"mongodb": NEXT}


@pytest.mark.asyncio
async def test_a_lost_position_reinventories_the_root():
    drain = AsyncMock(
        side_effect=[OperationFailure("lost", code=HISTORY_LOST), ([], NEXT)]
    )
    with patch("mirage.core.mongodb.watch.drain_changes", drain):
        delta = await _hook().pull(ROOT, json.dumps({"mongodb": TOKEN}))
    assert [(c.kind, c.path.virtual) for c in delta.changes] == [
        (FileChangeKind.UNKNOWN, "/m")
    ]
    assert json.loads(delta.checkpoint) == {"mongodb": NEXT}


@pytest.mark.asyncio
async def test_a_server_outside_a_replica_set_refuses_the_watch():
    drain = AsyncMock(
        side_effect=OperationFailure("no", code=CHANGE_STREAM_UNSUPPORTED)
    )
    with patch("mirage.core.mongodb.watch.drain_changes", drain):
        with pytest.raises(OperationNotSupportedError):
            await _hook().pull(ROOT, None)
