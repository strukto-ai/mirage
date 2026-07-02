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

from mirage.accessor.slack import SlackAccessor
from mirage.ops.slack.readdir import readdir
from mirage.types import PathSpec


def _scope(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
                    virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/")


@pytest.fixture
def accessor():
    return SlackAccessor(config=object())


@pytest.mark.asyncio
async def test_readdir_calls_core(accessor):
    fn = readdir._registered_ops[0].fn
    with patch(
            "mirage.ops.slack.readdir.core_readdir",
            new_callable=AsyncMock,
            return_value=["/channels/general.txt"],
    ) as mock:
        result = await fn(accessor, _scope("/channels"), index=None)
        mock.assert_called_once_with(accessor, _scope("/channels"), None)
        assert result == ["/channels/general.txt"]
