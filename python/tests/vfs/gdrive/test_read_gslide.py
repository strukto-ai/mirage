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

import json
from unittest.mock import AsyncMock

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdrive import GoogleDriveVFS
from tests.fixtures.google_api import serve
from tests.fixtures.gslides_api import StubSlides
from tests.fixtures.vfs_io import call_over


def _op(name: str):
    return call_over(GoogleDriveVFS, name)


read = _op("read")


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


@pytest.fixture
def accessor():
    return GDriveAccessor(config=None, token_manager=None)


@pytest.mark.asyncio
async def test_read_gslide_renders_presentation_json(accessor):
    row = FileStat(
        name="deck.gslide.json",
        type=FileType.FILE,
        modified="2026-04-01T00:00:00Z",
        extra={"file_id": "slide123", "resource_type": "gdrive/gslide"},
    )
    slide_json = json.dumps({"presentationId": "slide123"}).encode()
    mock = AsyncMock(return_value=slide_json)
    with serve(slides=StubSlides(read_presentation=mock)):
        result = await read(
            accessor, _scope("/slides/deck.gslide.json"), entry=row
        )
        mock.assert_called_once_with("slide123")
        assert json.loads(result)["presentationId"] == "slide123"


@pytest.mark.asyncio
async def test_read_gslide_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _scope("/nonexistent.gslide.json"))
