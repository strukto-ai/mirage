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

from mirage.cache.index import IndexEntry
from mirage.core.gdrive.read import read_file_versioned
from mirage.core.gdrive.versions import (capture_file_metadata,
                                         download_revision, list_revisions)
from mirage.observe.context import push_revisions, reset_revisions

ENTRY = IndexEntry(id="f1",
                   name="f.txt",
                   resource_type="gdrive/file",
                   vfs_name="f.txt")


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
        md5, revision, modified = await capture_file_metadata(
            gdrive_accessor.token_manager, "f1")
    # The slots come back raw rather than coalesced: the caller verifies an
    # md5 against the bytes it downloaded, and a token it could not tell
    # apart from a revision would be dropped for every file Drive gives no
    # md5 for.
    assert (md5, revision, modified) == ("abc", "r9", None)


@pytest.mark.asyncio
async def test_capture_falls_back_to_head_revision(gdrive_accessor):
    with patch(
            "mirage.core.gdrive.versions.google_get",
            new_callable=AsyncMock,
            return_value={"headRevisionId": "r9"},
    ):
        md5, revision, modified = await capture_file_metadata(
            gdrive_accessor.token_manager, "f1")
    # The coalescing that used to happen here now happens in the caller,
    # through drive_fingerprint, so an absent md5 reads as absent.
    assert (md5, revision, modified) == (None, "r9", None)


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
                                             "f1", "/data/f.txt", ENTRY)
    finally:
        reset_revisions(token)
    assert data == b"pinned"
    pinned_read.assert_awaited_once_with(gdrive_accessor.token_manager, "f1",
                                         "r1", None)
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
                                         "/data/f.txt", ENTRY)
    assert data == b"live"
    # No active recorder: the extra metadata call is skipped.
    capture.assert_not_awaited()


@pytest.mark.asyncio
async def test_capture_asks_for_the_stamp_as_well(gdrive_accessor):
    """The capture's third field is what keeps a token-less file matching.

    A Drive shortcut has no md5 and no revision. Without modifiedTime in the
    mask the read answers None while stat answers a stamp -- the exact
    read/stat mismatch this change exists to remove, reintroduced one file
    type at a time.
    """
    captured = {}

    async def fake_get(token_manager, url, params=None):
        captured["params"] = params
        return {}

    with patch("mirage.core.gdrive.versions.google_get", new=fake_get):
        await capture_file_metadata(gdrive_accessor.token_manager, "f1")

    assert "modifiedTime" in captured["params"]["fields"]


@pytest.mark.asyncio
async def test_capture_returns_the_stamp_when_no_token_exists(gdrive_accessor):
    """Widening the request is not the same as wiring the value through.

    The caller coalesces, so the capture has to hand back all three slots
    raw. A version that asked for modifiedTime and then dropped it would
    leave the fields assertion above green and still answer None here.
    """
    with patch(
            "mirage.core.gdrive.versions.google_get",
            new_callable=AsyncMock,
            return_value={"modifiedTime": "2026-04-01T00:00:00.000Z"},
    ):
        md5, revision, modified = await capture_file_metadata(
            gdrive_accessor.token_manager, "f1")

    assert md5 is None
    assert revision is None
    assert modified == "2026-04-01T00:00:00.000Z"
