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

import errno
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.gdocs import GDocsAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdocs.rename import rename
from mirage.core.google.rename import app_title
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

SUFFIX = ".gdoc.json"
MODIFIED = "2026-10-01T09:00:00.000Z"
OLD = "2026-10-01_Old_Plan__doc1.gdoc.json"


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(virtual, "/gdocs"),
        virtual=virtual,
        directory=virtual,
    )


async def seeded() -> RAMIndexCacheStore:
    store = RAMIndexCacheStore()
    await store.set_dir(
        "/gdocs/owned",
        [
            (
                OLD,
                IndexEntry(
                    id="doc1",
                    name="Old Plan",
                    resource_type="gdocs/file",
                    remote_time=MODIFIED,
                    vfs_name=OLD,
                ),
            )
        ],
    )
    return store


def test_a_name_the_listing_renders_back_gives_its_title():
    name = "2026-10-01_New_Plan__doc1.gdoc.json"
    assert app_title(name, "doc1", MODIFIED, SUFFIX) == "New_Plan"


@pytest.mark.parametrize(
    "name",
    [
        "2026-09-30_New__doc1.gdoc.json",
        "2026-10-01_New__doc2.gdoc.json",
        "2026-10-01_New Plan__doc1.gdoc.json",
    ],
)
def test_any_other_name_gives_none(name):
    assert app_title(name, "doc1", MODIFIED, SUFFIX) is None


@pytest.mark.asyncio
async def test_rename_sets_the_title_and_keeps_the_modified_time():
    index = await seeded()
    with (
        patch(
            "mirage.core.google.rename.get_file",
            new_callable=AsyncMock,
            return_value={"id": "doc1", "modifiedTime": MODIFIED},
        ),
        patch(
            "mirage.core.google.rename.patch_file", new_callable=AsyncMock
        ) as patched,
    ):
        await rename(
            GDocsAccessor(config=None, token_manager=None),
            spec(f"/gdocs/owned/{OLD}"),
            spec("/gdocs/owned/2026-10-01_New_Plan__doc1.gdoc.json"),
            index,
        )
    assert patched.await_args.args[1:] == (
        "doc1",
        {"name": "New_Plan", "modifiedTime": MODIFIED},
    )
    listing = await index.list_dir("/gdocs/owned")
    assert listing.entries is None


@pytest.mark.parametrize(
    "dst",
    [
        "/gdocs/owned/New_Plan.gdoc.json",
        "/gdocs/shared/2026-10-01_New_Plan__doc1.gdoc.json",
    ],
)
@pytest.mark.asyncio
async def test_a_name_the_listing_cannot_render_is_eperm(dst):
    index = await seeded()
    with (
        patch(
            "mirage.core.google.rename.get_file",
            new_callable=AsyncMock,
            return_value={"id": "doc1", "modifiedTime": MODIFIED},
        ),
        patch(
            "mirage.core.google.rename.patch_file", new_callable=AsyncMock
        ) as patched,
    ):
        with pytest.raises(OSError) as raised:
            await rename(
                GDocsAccessor(config=None, token_manager=None),
                spec(f"/gdocs/owned/{OLD}"),
                spec(dst),
                index,
            )
    assert raised.value.errno == errno.EPERM
    assert patched.await_count == 0
