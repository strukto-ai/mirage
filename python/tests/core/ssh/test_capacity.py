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

from unittest.mock import AsyncMock, MagicMock

import asyncssh
import pytest

from mirage.core.ssh.capacity import capacity
from mirage.types import CapacityResult, CapacityState
from tests.fixtures.ssh_run import RunAccessor

STATVFS = asyncssh.SFTPVFSAttrs(
    bsize=4096,
    frsize=1024,
    blocks=100,
    bfree=40,
    bavail=30,
    files=50,
    ffree=20,
    favail=10,
)


@pytest.mark.parametrize(
    ("statvfs", "expected"),
    [
        (
            AsyncMock(return_value=STATVFS),
            CapacityResult(
                state=CapacityState.QUOTA,
                total=102400,
                used=61440,
                available=30720,
                inodes=50,
                inodes_used=30,
                inodes_free=10,
            ),
        ),
        (
            AsyncMock(side_effect=asyncssh.SFTPOpUnsupported("no")),
            CapacityResult(state=CapacityState.UNKNOWN),
        ),
    ],
)
@pytest.mark.asyncio
async def test_statvfs_is_counted_as_df_counts_a_disk(statvfs, expected):
    accessor = RunAccessor("/srv", (0, b"", b""), MagicMock(statvfs=statvfs))
    assert await capacity(accessor) == expected
    assert statvfs.await_args.args == ("/srv",)
