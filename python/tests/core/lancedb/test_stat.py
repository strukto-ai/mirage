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

from mirage.core.lancedb.stat import stat
from mirage.types import FileType, PathSpec


def _ps(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


@pytest.mark.asyncio
async def test_stat_group_dir_is_directory(accessor):
    s = await stat(accessor, _ps("/animals/cat"))
    assert s.type == FileType.DIRECTORY
    assert s.name == "cat"


@pytest.mark.asyncio
async def test_stat_card_is_text_with_size(accessor):
    s = await stat(accessor, _ps("/animals/cat/big/1.md"))
    assert s.type == FileType.TEXT
    assert s.size and s.size > 0


@pytest.mark.asyncio
async def test_stat_blob_is_image(accessor):
    s = await stat(accessor, _ps("/animals/cat/big/1.png"))
    assert s.type == FileType.IMAGE_PNG
    assert s.size == len(b"PNG-1")


@pytest.mark.asyncio
async def test_stat_unknown_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _ps("/animals/cat/big/1.weird/x"))
