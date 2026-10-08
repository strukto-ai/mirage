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

import pytest

from mirage.accessor.gslides import GSlidesAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gslides import GSlidesVFS
from tests.fixtures.vfs_io import call_over


def _op(name: str):
    return call_over(GSlidesVFS, name)


stat = _op("stat")


def _scope(path: str, prefix: str = "/gslides") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


@pytest.fixture
def accessor():
    return GSlidesAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_stat_root_is_directory(accessor, index):
    result = await stat(accessor, _scope("/gslides"), index=index)
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_slide(accessor, index):
    await index.set_dir(
        "/gslides/owned",
        [
            (
                "Deck__slide1.gslide.json",
                IndexEntry(
                    id="slide1",
                    name="Deck",
                    resource_type="gslides/slide",
                    remote_time="2026-04-01T00:00:00Z",
                    vfs_name="Deck__slide1.gslide.json",
                ),
            )
        ],
    )
    result = await stat(
        accessor,
        _scope("/gslides/owned/Deck__slide1.gslide.json"),
        index=index,
    )
    assert result.name == "Deck__slide1.gslide.json"
    assert result.extra["doc_id"] == "slide1"


@pytest.mark.asyncio
async def test_stat_not_found(accessor, index):
    await index.set_dir("/gslides/owned", [])
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            _scope("/gslides/owned/Nonexistent__slide9.gslide.json"),
            index=index,
        )
