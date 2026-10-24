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

from unittest.mock import patch

import pytest

from mirage.accessor.gridfs import GridFSAccessor
from mirage.core.gridfs.events import GridFSEventHook
from mirage.types import FileChangeKind, JsonValue, PathSpec
from mirage.vfs.gridfs.config import GridFSConfig

ROOT = PathSpec.from_str_path("/g", vfs_path="")
NS = {"db": "lib", "coll": "fs.files"}


class Revisions:
    """A files collection answering how many revisions a name has."""

    def __init__(self) -> None:
        self.count: dict[str, int] = {}

    async def count_documents(self, query: dict[str, str], limit: int) -> int:
        return min(self.count.get(query["filename"], 0), limit)


def _event(kind: str, ident: int, **body: JsonValue) -> dict[str, JsonValue]:
    return {
        "operationType": kind,
        "ns": NS,
        "documentKey": {"_id": ident},
        **body,
    }


@pytest.mark.asyncio
async def test_revisions_left_decide_each_change():
    # An insert is a CREATE when its revision is the only one and an
    # UPDATE otherwise; a delete leaves a DELETE, or an UPDATE when an
    # older revision is served again. A rename settles both names, and a
    # delete the hook cannot name leaves the mount UNKNOWN.
    files = Revisions()
    hook = GridFSEventHook(
        GridFSAccessor(
            GridFSConfig(uri="mongodb://x", database="lib", key_prefix="docs/")
        )
    )
    steps = [
        (
            {"docs/a.txt": 1},
            _event("insert", 1, fullDocument={"filename": "docs/a.txt"}),
        ),
        (
            {"docs/a.txt": 2},
            _event("insert", 2, fullDocument={"filename": "docs/a.txt"}),
        ),
        ({"docs/a.txt": 1}, _event("delete", 2)),
        (
            {"docs/a.txt": 0, "docs/b.txt": 1},
            _event(
                "update",
                1,
                updateDescription={
                    "updatedFields": {"filename": "docs/b.txt"}
                },
            ),
        ),
        ({}, _event("insert", 3, fullDocument={"filename": "other/x"})),
        ({}, _event("insert", 4, fullDocument={"filename": "docs/dir/"})),
        ({}, _event("delete", 9)),
        ({}, {"operationType": "drop", "ns": NS}),
        ({}, {"operationType": "insert", "ns": {"db": "lib", "coll": "logs"}}),
    ]
    pairs = []
    with patch("mirage.core.gridfs.events.files_coll", return_value=files):
        for counts, event in steps:
            files.count.update(counts)
            pairs += [
                (change.kind, change.path.virtual)
                for change in await hook.to_events(
                    ROOT, str(event["operationType"]), event
                )
            ]
    assert pairs == [
        (FileChangeKind.CREATE, "/g/a.txt"),
        (FileChangeKind.UPDATE, "/g/a.txt"),
        (FileChangeKind.UPDATE, "/g/a.txt"),
        (FileChangeKind.DELETE, "/g/a.txt"),
        (FileChangeKind.CREATE, "/g/b.txt"),
        (FileChangeKind.CREATE, "/g/dir"),
        (FileChangeKind.UNKNOWN, "/g"),
        (FileChangeKind.UNKNOWN, "/g"),
    ]


@pytest.mark.asyncio
async def test_a_rename_into_the_trash_settles_only_the_name_left():
    # rm retags a.txt to /trash/a.txt: the name left behind reads as
    # deleted, and the trash, which no path reaches, raises nothing.
    files = Revisions()
    hook = GridFSEventHook(
        GridFSAccessor(GridFSConfig(uri="mongodb://x", database="lib"))
    )
    files.count.update({"a.txt": 0, "/trash/a.txt": 2})
    rename = _event(
        "update",
        1,
        fullDocumentBeforeChange={"filename": "a.txt"},
        updateDescription={"updatedFields": {"filename": "/trash/a.txt"}},
    )
    insert = _event("insert", 2, fullDocument={"filename": "/trash/b.txt"})
    with patch("mirage.core.gridfs.events.files_coll", return_value=files):
        changes = await hook.to_events(ROOT, "update", rename)
        assert await hook.to_events(ROOT, "insert", insert) == ()
    assert [(c.kind, c.path.virtual) for c in changes] == [
        (FileChangeKind.DELETE, "/g/a.txt")
    ]
