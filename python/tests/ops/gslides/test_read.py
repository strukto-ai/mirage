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
from mirage.ops.gslides.read import read
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _scope(path: str, prefix: str = "/gslides") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/")


@pytest.fixture
def accessor():
    return GSlidesAccessor(config=None, token_manager=None)


@pytest.mark.asyncio
async def test_read_calls_core(accessor):
    fn = read._registered_ops[0].fn
    with patch(
            "mirage.ops.gslides.read.core_read",
            new_callable=AsyncMock,
            return_value=b'{"presentationId": "slide1"}',
    ) as mock:
        scope = _scope("/gslides/owned/deck.gslide.json")
        result = await fn(accessor, scope, index=None)
        mock.assert_called_once_with(
            accessor,
            _scope("/gslides/owned/deck.gslide.json", prefix="/gslides"), None)
        assert b"slide1" in result


@pytest.mark.asyncio
async def test_read_not_found(accessor):
    fn = read._registered_ops[0].fn
    with patch(
            "mirage.ops.gslides.read.core_read",
            new_callable=AsyncMock,
            side_effect=FileNotFoundError("not found"),
    ):
        with pytest.raises(FileNotFoundError):
            await fn(accessor,
                     _scope("/gslides/owned/nonexistent.gslide.json"),
                     index=None)
