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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.ops.gsheets.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _scope(path: str, prefix: str = "/gsheets") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/")


@pytest.fixture
def accessor():
    return GSheetsAccessor(config=None, token_manager=None)


@pytest.mark.asyncio
async def test_readdir_calls_core(accessor):
    fn = readdir._registered_ops[0].fn
    with patch(
            "mirage.ops.gsheets.readdir.core_readdir",
            new_callable=AsyncMock,
            return_value=["/gsheets/owned/budget.gsheet.json"],
    ) as mock:
        scope = _scope("/gsheets/owned")
        result = await fn(accessor, scope, index=None)
        mock.assert_called_once_with(
            accessor, _scope("/gsheets/owned", prefix="/gsheets"), None)
        assert result == ["/gsheets/owned/budget.gsheet.json"]
