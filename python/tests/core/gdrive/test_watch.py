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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.watch import build_delta_hook
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.core.google.drive import FOLDER_MIME
from mirage.types import FileChangeKind, PathSpec
from mirage.utils.key_prefix import mount_key

ROOT = PathSpec(
    vfs_path=mount_key("/drive", "/drive"),
    virtual="/drive",
    directory="/drive",
)

FOLDERS = {
    "root": {"id": "R"},
    "G": {"id": "G", "name": "Sub", "parents": ["F"]},
    "X": {"id": "X", "name": "Elsewhere"},
    "D": {"id": "D", "name": "Drive", "driveId": "D"},
}


def item(
    file_id: str,
    name: str,
    parent: str,
    mime: str = "text/plain",
    created: str = "2020-01-01T00:00:00.000Z",
    modified: str = "2026-10-01T00:00:00.000Z",
    trashed: bool = False,
) -> dict[str, Any]:
    return {
        "fileId": file_id,
        "file": {
            "id": file_id,
            "name": name,
            "mimeType": mime,
            "parents": [parent],
            "createdTime": created,
            "modifiedTime": modified,
            "trashed": trashed,
        },
    }


@pytest.mark.asyncio
async def test_changes_are_placed_by_their_parents():
    config = GoogleConfig(client_id="cid", refresh_token="rt")
    hook = build_delta_hook(
        GDriveAccessor(config=config, token_manager=TokenManager(config))
    )
    feed = [
        (
            [
                item("F", "Docs", "R", mime=FOLDER_MIME),
                item("a", "a.txt", "F", created="2026-10-01T00:00:00.000Z"),
                item(
                    "b", "b", "G", mime="application/vnd.google-apps.document"
                ),
                item("c", "c.txt", "X"),
                item("d", "d.txt", "D"),
            ],
            "2",
        ),
        (
            [
                item("F", "Papers", "R", mime=FOLDER_MIME),
                item("a", "a.txt", "F", trashed=True),
                {"changeType": "drive", "driveId": "D"},
                {"fileId": "unseen", "removed": True},
            ],
            "3",
        ),
    ]
    with (
        patch(
            "mirage.core.gdrive.watch.start_page_token",
            new_callable=AsyncMock,
            return_value="1",
        ),
        patch(
            "mirage.core.gdrive.watch.list_changes",
            new_callable=AsyncMock,
            side_effect=feed,
        ),
        patch(
            "mirage.core.gdrive.watch.get_file",
            new_callable=AsyncMock,
            side_effect=lambda tm, file_id: FOLDERS[file_id],
        ),
        patch(
            "mirage.core.gdrive.watch.list_files",
            new_callable=AsyncMock,
            return_value=[{"name": "Team", "mimeType": FOLDER_MIME}],
        ),
        patch(
            "mirage.core.gdrive.watch.list_shared_drives",
            new_callable=AsyncMock,
            return_value=[{"id": "D", "name": "Team"}],
        ),
    ):
        baseline = await hook.pull(ROOT, None)
        first = await hook.pull(ROOT, baseline.checkpoint)
        second = await hook.pull(ROOT, first.checkpoint)
    assert baseline.changes == ()
    assert [(c.kind, c.path.virtual) for c in first.changes] == [
        (FileChangeKind.UPDATE, "/drive/Docs"),
        (FileChangeKind.CREATE, "/drive/Docs/a.txt"),
        (FileChangeKind.UPDATE, "/drive/Docs/Sub/b.gdoc.json"),
        (FileChangeKind.UPDATE, "/drive/Team [Shared Drive]/d.txt"),
    ]
    assert [(c.kind, c.path.virtual) for c in second.changes] == [
        (FileChangeKind.DELETE, "/drive/Docs"),
        (FileChangeKind.CREATE, "/drive/Papers"),
        (FileChangeKind.DELETE, "/drive/Papers/a.txt"),
        (FileChangeKind.UNKNOWN, "/drive"),
    ]


async def _pulls(feed: list, root_names: list[list[str]]) -> list:
    """Pull a baseline and then one read per page of ``feed``, the root
    listing naming ``root_names[n]`` on read ``n``."""
    config = GoogleConfig(client_id="cid", refresh_token="rt")
    hook = build_delta_hook(
        GDriveAccessor(config=config, token_manager=TokenManager(config))
    )
    listings = iter(root_names)
    with (
        patch(
            "mirage.core.gdrive.watch.start_page_token",
            new_callable=AsyncMock,
            return_value="1",
        ),
        patch(
            "mirage.core.gdrive.watch.list_changes",
            new_callable=AsyncMock,
            side_effect=feed,
        ),
        patch(
            "mirage.core.gdrive.watch.get_file",
            new_callable=AsyncMock,
            side_effect=lambda tm, file_id: FOLDERS[file_id],
        ),
        patch(
            "mirage.core.gdrive.watch.list_files",
            new_callable=AsyncMock,
            side_effect=lambda tm, folder: [
                {"name": name, "mimeType": FOLDER_MIME}
                for name in next(listings)
            ],
        ),
        patch(
            "mirage.core.gdrive.watch.list_shared_drives",
            new_callable=AsyncMock,
            return_value=[{"id": "D", "name": "Team"}],
        ),
    ):
        delta = await hook.pull(ROOT, None)
        out = []
        for _ in feed:
            delta = await hook.pull(ROOT, delta.checkpoint)
            out.append([(c.kind, c.path.virtual) for c in delta.changes])
    return out


@pytest.mark.asyncio
async def test_a_child_listed_before_its_renamed_folder_lands_in_it():
    edited = "2026-10-01T00:00:00.000Z"
    first, second = await _pulls(
        [
            ([item("F", "Docs", "R", mime=FOLDER_MIME)], "2"),
            (
                [
                    item("c", "a.txt", "F", created=edited, modified=edited),
                    item("F", "Papers", "R", mime=FOLDER_MIME),
                ],
                "3",
            ),
        ],
        [],
    )
    assert first == [(FileChangeKind.UPDATE, "/drive/Docs")]
    assert second == [
        (FileChangeKind.CREATE, "/drive/Papers/a.txt"),
        (FileChangeKind.DELETE, "/drive/Docs"),
        (FileChangeKind.CREATE, "/drive/Papers"),
    ]


@pytest.mark.asyncio
async def test_a_shared_drive_is_named_as_the_root_listing_names_it_now():
    # A My Drive folder named like the drive arrives between two reads,
    # and the root listing renames the drive "Team [Shared Drive]".
    first, second = await _pulls(
        [([item("d", "d.txt", "D")], "2"), ([item("d", "d.txt", "D")], "3")],
        [[], ["Team"]],
    )
    assert first == [(FileChangeKind.UPDATE, "/drive/Team/d.txt")]
    assert second == [
        (FileChangeKind.DELETE, "/drive/Team/d.txt"),
        (FileChangeKind.CREATE, "/drive/Team [Shared Drive]/d.txt"),
    ]
