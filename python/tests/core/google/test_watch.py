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
from mirage.core.gdocs.readdir import readdir
from mirage.core.gdocs.stat import stat
from mirage.core.google.watch import app_delta_hook
from mirage.types import FileChangeKind, PathSpec
from mirage.utils.key_prefix import mount_key

ROOT = PathSpec(
    vfs_path=mount_key("/gdocs", "/gdocs"),
    virtual="/gdocs",
    directory="/gdocs",
)


def listing(
    modified: str, complete: bool = True
) -> tuple[list[dict[str, Any]], bool]:
    return (
        [
            {
                "id": "doc1",
                "name": "Plan",
                "modifiedTime": modified,
                "owners": [{"me": True}],
            }
        ],
        complete,
    )


@pytest.mark.asyncio
async def test_an_edit_is_an_update_and_an_unfinished_listing_fails():
    hook = app_delta_hook(
        GDocsAccessor(config=None, token_manager=None), readdir, stat
    )
    with patch(
        "mirage.core.google.readdir.list_all_files",
        new_callable=AsyncMock,
        side_effect=[
            listing("2026-10-01T09:00:00.000Z"),
            listing("2026-10-01T09:00:00.000Z"),
            listing("2026-10-01T10:00:00.000Z"),
            listing("2026-10-01T10:00:00.000Z"),
            listing("2026-10-01T11:00:00.000Z", complete=False),
        ],
    ):
        baseline = await hook.pull(ROOT, None)
        changed = await hook.pull(ROOT, baseline.checkpoint)
        with pytest.raises(OSError):
            await hook.pull(ROOT, changed.checkpoint)
    assert baseline.changes == ()
    assert [(c.kind, c.path.virtual) for c in changed.changes] == [
        (
            FileChangeKind.UPDATE,
            "/gdocs/owned/2026-10-01_Plan__doc1.gdoc.json",
        )
    ]
