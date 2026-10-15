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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.capacity import capacity
from mirage.core.dropbox.client import DropboxTokenManager
from mirage.types import CapacityResult, CapacityState
from mirage.vfs.dropbox.config import DropboxConfig


@pytest.mark.parametrize(
    ("allocation", "used", "total"),
    [
        ({".tag": "individual", "allocated": 1000}, 300, 1000),
        (
            {
                ".tag": "team",
                "used": 900,
                "allocated": 5000,
                "user_within_team_space_allocated": 1000,
            },
            300,
            1000,
        ),
        (
            {
                ".tag": "team",
                "used": 900,
                "allocated": 5000,
                "user_within_team_space_allocated": 0,
            },
            900,
            5000,
        ),
    ],
)
@pytest.mark.asyncio
async def test_the_allocation_that_bounds_the_account_is_the_quota(
    allocation, used, total
):
    config = DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
    with patch(
        "mirage.core.dropbox.capacity.dropbox_rpc",
        new_callable=AsyncMock,
        return_value={"used": 300, "allocation": allocation},
    ) as rpc:
        result = await capacity(
            DropboxAccessor(config, DropboxTokenManager(config))
        )
    assert rpc.await_args.args[1:] == ("/users/get_space_usage", None)
    assert result == CapacityResult(
        state=CapacityState.QUOTA,
        total=total,
        used=used,
        available=total - used,
    )
