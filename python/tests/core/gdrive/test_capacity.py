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

from unittest.mock import AsyncMock

import pytest

from mirage.core.gdrive.capacity import capacity
from mirage.types import CapacityResult, CapacityState
from tests.fixtures.gdrive_api import StubDrive, install_drive


@pytest.mark.parametrize(
    ("shared", "quota", "expected"),
    [
        (
            None,
            {"limit": "1000", "usage": "400"},
            CapacityResult(
                state=CapacityState.QUOTA, total=1000, used=400, available=600
            ),
        ),
        (None, {"usage": "400"}, CapacityResult(state=CapacityState.ELASTIC)),
        ("drive-1", {}, CapacityResult(state=CapacityState.UNKNOWN)),
    ],
)
@pytest.mark.asyncio
async def test_the_storage_quota_is_the_capacity(
    scoped_accessor, monkeypatch, shared, quota, expected
):
    accessor = scoped_accessor("folder")
    accessor.root_drive_id = shared
    install_drive(
        monkeypatch, StubDrive(storage_quota=AsyncMock(return_value=quota))
    )
    assert await capacity(accessor) == expected
