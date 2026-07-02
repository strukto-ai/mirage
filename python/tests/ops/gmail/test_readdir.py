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

from mirage.accessor.gmail import GmailAccessor
from mirage.ops.gmail.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GmailAccessor(config=None, token_manager=None)


@pytest.mark.asyncio
async def test_readdir_calls_core(accessor):
    fn = readdir._registered_ops[0].fn
    with patch(
            "mirage.ops.gmail.readdir.core_readdir",
            new_callable=AsyncMock,
            return_value=["/gmail/inbox/msg.txt"],
    ) as mock:
        scope = PathSpec(
            resource_path=mount_key("/gmail/inbox", "/gmail"),
            virtual="/gmail/inbox",
            directory="/gmail",
        )
        result = await fn(accessor, scope, index=None)
        mock.assert_called_once_with(accessor, scope, None)
        assert result == ["/gmail/inbox/msg.txt"]
