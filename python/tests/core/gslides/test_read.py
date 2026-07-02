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

from mirage.accessor.gslides import GSlidesAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gslides.read import read
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GSlidesAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_read_auto_bootstraps_from_empty_index(accessor, index):
    files = [{
        "id": "slide1",
        "name": "Deck",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [{
            "me": True
        }],
    }]
    with (
            patch(
                "mirage.core.gslides.readdir.list_all_files",
                new_callable=AsyncMock,
                return_value=files,
            ),
            patch(
                "mirage.core.gslides.read.read_presentation",
                new_callable=AsyncMock,
                return_value=b'{"presentationId":"slide1"}',
            ),
    ):
        path = PathSpec(
            resource_path=mount_key(
                "/gslides/owned/2026-04-01_Deck__slide1.gslide.json",
                "/gslides"),
            virtual="/gslides/owned/2026-04-01_Deck__slide1.gslide.json",
            directory="/gslides/owned/2026-04-01_Deck__slide1.gslide.json",
        )
        result = await read(accessor, path, index)
        assert b"slide1" in result


@pytest.mark.asyncio
async def test_read_missing_file_raises_after_recursion(accessor, index):
    with (
            patch(
                "mirage.core.gslides.readdir.list_all_files",
                new_callable=AsyncMock,
                return_value=[],
            ),
            patch(
                "mirage.core.gslides.read.read_presentation",
                new_callable=AsyncMock,
                side_effect=AssertionError(
                    "should not call read_presentation"),
            ),
    ):
        path = PathSpec(
            resource_path=mount_key("/gslides/owned/Missing__xyz.gslide.json",
                                    "/gslides"),
            virtual="/gslides/owned/Missing__xyz.gslide.json",
            directory="/gslides/owned/Missing__xyz.gslide.json",
        )
        with pytest.raises(FileNotFoundError):
            await read(accessor, path, index)
