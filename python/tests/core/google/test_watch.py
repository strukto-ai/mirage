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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.gdocs import GDocsAccessor
from mirage.core.gdocs.constants import MIME
from mirage.core.google.watch import app_delta_hook
from mirage.types import FileChangeKind, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdocs.doc_entry import make_filename

ROOT = PathSpec(
    vfs_path=mount_key("/gdocs", "/gdocs"),
    virtual="/gdocs",
    directory="/gdocs",
)


def doc(
    file_id: str,
    name: str,
    modified: str,
    created: str = "2020-01-01T00:00:00.000Z",
    mime: str = MIME,
    mine: bool = True,
    trashed: bool = False,
) -> dict[str, Any]:
    return {
        "fileId": file_id,
        "file": {
            "id": file_id,
            "name": name,
            "mimeType": mime,
            "createdTime": created,
            "modifiedTime": modified,
            "owners": [{"me": mine}],
            "trashed": trashed,
        },
    }


@pytest.mark.asyncio
async def test_changes_place_each_doc_where_the_app_lists_it():
    hook = app_delta_hook(
        GDocsAccessor(config=None, token_manager=None), MIME, make_filename
    )
    with (
        patch(
            "mirage.core.google.watch.start_page_token",
            new_callable=AsyncMock,
            return_value="1",
        ),
        patch(
            "mirage.core.google.watch.list_changes",
            new_callable=AsyncMock,
            side_effect=[
                (
                    [
                        doc("old", "Plan", "2026-10-01T09:00:00.000Z"),
                        doc(
                            "new",
                            "Notes",
                            "2099-01-01T09:00:00.000Z",
                            created="2099-01-01T09:00:00.000Z",
                            mine=False,
                        ),
                        doc(
                            "sheet",
                            "Budget",
                            "2026-10-01T09:00:00.000Z",
                            mime="application/vnd.google-apps.spreadsheet",
                        ),
                    ],
                    "2",
                ),
                (
                    [
                        doc("old", "Plan", "2026-10-02T09:00:00.000Z"),
                        doc(
                            "new",
                            "Notes",
                            "2099-01-01T09:00:00.000Z",
                            trashed=True,
                            mine=False,
                        ),
                        {"fileId": "gone", "removed": True},
                    ],
                    "3",
                ),
            ],
        ),
    ):
        baseline = await hook.pull(ROOT, None)
        first = await hook.pull(ROOT, baseline.checkpoint)
        second = await hook.pull(ROOT, first.checkpoint)
    assert baseline.changes == ()
    assert [(c.kind, c.path.virtual) for c in first.changes] == [
        (FileChangeKind.UPDATE, "/gdocs/owned/2026-10-01_Plan__old.gdoc.json"),
        (
            FileChangeKind.CREATE,
            "/gdocs/shared/2099-01-01_Notes__new.gdoc.json",
        ),
    ]
    assert [(c.kind, c.path.virtual) for c in second.changes] == [
        (FileChangeKind.DELETE, "/gdocs/owned/2026-10-01_Plan__old.gdoc.json"),
        (FileChangeKind.CREATE, "/gdocs/owned/2026-10-02_Plan__old.gdoc.json"),
        (
            FileChangeKind.DELETE,
            "/gdocs/shared/2099-01-01_Notes__new.gdoc.json",
        ),
    ]
