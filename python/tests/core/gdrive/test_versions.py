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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.gdrive.read import read_file_versioned
from mirage.core.gdrive.versions import (capture_file_metadata,
                                         download_revision, list_revisions)
from mirage.observe.context import push_revisions, reset_revisions


@pytest.mark.asyncio
async def test_list_revisions_paginates(gdrive_accessor):
    pages = [
        {
            "revisions": [{
                "id": "r1"
            }],
            "nextPageToken": "next"
        },
        {
            "revisions": [{
                "id": "r2"
            }]
        },
    ]
    with patch(
            "mirage.core.gdrive.versions.google_get",
            new_callable=AsyncMock,
            side_effect=pages,
    ):
        revs = await list_revisions(gdrive_accessor.token_manager, "f1")
    assert [r["id"] for r in revs] == ["r1", "r2"]


@pytest.mark.asyncio
async def test_download_revision_hits_revision_url(gdrive_accessor):
    with patch(
            "mirage.core.gdrive.versions.google_get_bytes",
            new_callable=AsyncMock,
            return_value=b"old",
    ) as get_bytes:
        data = await download_revision(gdrive_accessor.token_manager, "f1",
                                       "r1")
    assert data == b"old"
    assert "/files/f1/revisions/r1?alt=media" in get_bytes.await_args.args[1]


@pytest.mark.asyncio
async def test_capture_file_metadata(gdrive_accessor):
    with patch(
            "mirage.core.gdrive.versions.google_get",
            new_callable=AsyncMock,
            return_value={
                "headRevisionId": "r9",
                "md5Checksum": "abc"
            },
    ):
        fingerprint, revision = await capture_file_metadata(
            gdrive_accessor.token_manager, "f1")
    assert (fingerprint, revision) == ("abc", "r9")


@pytest.mark.asyncio
async def test_capture_falls_back_to_head_revision(gdrive_accessor):
    with patch(
            "mirage.core.gdrive.versions.google_get",
            new_callable=AsyncMock,
            return_value={"headRevisionId": "r9"},
    ):
        fingerprint, revision = await capture_file_metadata(
            gdrive_accessor.token_manager, "f1")
    assert (fingerprint, revision) == ("r9", "r9")


@pytest.mark.asyncio
async def test_read_file_versioned_pinned(gdrive_accessor):
    token = push_revisions({"/data/f.txt": "r1"})
    try:
        with patch(
                "mirage.core.gdrive.read.download_revision",
                new_callable=AsyncMock,
                return_value=b"pinned",
        ) as pinned_read, patch(
                "mirage.core.gdrive.read.download_file",
                new_callable=AsyncMock,
        ) as live_read:
            data = await read_file_versioned(gdrive_accessor.token_manager,
                                             "f1", "/data/f.txt", "f.txt")
    finally:
        reset_revisions(token)
    assert data == b"pinned"
    pinned_read.assert_awaited_once_with(gdrive_accessor.token_manager, "f1",
                                         "r1")
    live_read.assert_not_awaited()


@pytest.mark.asyncio
async def test_read_file_versioned_unpinned_reads_live(gdrive_accessor):
    with patch(
            "mirage.core.gdrive.read.download_file",
            new_callable=AsyncMock,
            return_value=b"live",
    ), patch(
            "mirage.core.gdrive.read.capture_file_metadata",
            new_callable=AsyncMock,
    ) as capture:
        data = await read_file_versioned(gdrive_accessor.token_manager, "f1",
                                         "/data/f.txt", "f.txt")
    assert data == b"live"
    # No active recorder: the extra metadata call is skipped.
    capture.assert_not_awaited()
