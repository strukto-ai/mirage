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

from mirage.core.lancedb.read import read
from mirage.types import PathSpec


def _ps(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


@pytest.mark.asyncio
async def test_read_card_renders_title_and_fields(accessor):
    data = (await read(accessor, _ps("/animals/cat/big/1.md"))).decode()
    assert "# a big orange cat" in data
    assert "label: cat" in data
    assert "blob: 1.png" in data
    assert "vector" not in data


@pytest.mark.asyncio
async def test_read_blob_returns_raw_bytes(accessor):
    data = await read(accessor, _ps("/animals/cat/big/1.png"))
    assert data == b"PNG-1"


@pytest.mark.asyncio
async def test_read_missing_row_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _ps("/animals/cat/big/999.md"))
