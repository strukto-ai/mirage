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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdrive.checksum import checksum
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.observe.context import push_revisions, reset_revisions
from mirage.types import PathSpec

SCOPE = PathSpec(vfs_path="r.pdf", virtual="/r.pdf", directory="/")


@pytest.fixture
def accessor():
    config = GoogleConfig(
        client_id="id", client_secret="secret", refresh_token="refresh"
    )
    manager = TokenManager(config)
    manager._access_token = "fake-token"
    manager._expires_at = 9999999999
    return GDriveAccessor(config=config, token_manager=manager)


async def _index(resource_type: str) -> RAMIndexCacheStore:
    index = RAMIndexCacheStore()
    await index.set_dir(
        "/",
        [
            (
                "r.pdf",
                IndexEntry(
                    id="f1",
                    name="r.pdf",
                    resource_type=resource_type,
                    vfs_name="r.pdf",
                ),
            )
        ],
    )
    return index


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "algorithm,field",
    [
        ("md5", "md5Checksum"),
        ("sha1", "sha1Checksum"),
        ("sha256", "sha256Checksum"),
    ],
)
async def test_drive_answers_the_digest_it_keeps(accessor, algorithm, field):
    index = await _index("gdrive/file")
    with patch(
        "mirage.core.gdrive.checksum.google_get",
        new_callable=AsyncMock,
        return_value={field: "ABC123"},
    ) as get:
        assert await checksum(accessor, SCOPE, algorithm, index) == "abc123"
    assert get.await_args.kwargs["params"]["fields"] == field


@pytest.mark.asyncio
async def test_a_native_file_or_another_algorithm_reads(accessor):
    with patch(
        "mirage.core.gdrive.checksum.google_get", new_callable=AsyncMock
    ) as get:
        doc = await _index("gdrive/gdoc")
        assert await checksum(accessor, SCOPE, "md5", doc) is None
        binary = await _index("gdrive/file")
        assert await checksum(accessor, SCOPE, "sha512", binary) is None
    get.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_pinned_revision_reads(accessor):
    token = push_revisions({SCOPE.virtual: "r7"})
    try:
        with patch(
            "mirage.core.gdrive.checksum.google_get", new_callable=AsyncMock
        ) as get:
            index = await _index("gdrive/file")
            assert await checksum(accessor, SCOPE, "md5", index) is None
        get.assert_not_awaited()
    finally:
        reset_revisions(token)
