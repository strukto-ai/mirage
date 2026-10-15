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

from mirage.core.hf_hub.client import HfHubError
from mirage.core.hf_hub.exists import exists
from mirage.core.hf_hub.readdir import readdir
from mirage.types import PathSpec
from tests.core.hf_hub.conftest import ps
from tests.fixtures.handed import call


async def _exists(accessor, path: PathSpec) -> bool:
    return await call(exists, readdir, accessor, path)


@pytest.mark.asyncio
async def test_exists_for_a_file_a_directory_and_the_root(loaded):
    assert await _exists(loaded, ps("a.txt")) is True
    assert await _exists(loaded, ps("d")) is True
    assert await _exists(loaded, ps("")) is True


@pytest.mark.asyncio
async def test_exists_is_false_for_an_absence(loaded):
    assert await _exists(loaded, ps("nope")) is False


@pytest.mark.asyncio
async def test_exists_lets_a_refusal_through(accessor):
    # "Cannot see the repo" is not "the file is absent".
    refused = AsyncMock(side_effect=HfHubError("expired", 401))
    with patch("mirage.core.hf_hub.readdir.fetch_tree", refused):
        with pytest.raises(PermissionError):
            await _exists(accessor, ps("a.txt"))
