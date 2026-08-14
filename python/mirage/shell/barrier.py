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

from enum import Enum

from mirage.io import IOResult
from mirage.io.stream import drain, materialize
from mirage.io.types import ByteSource


class BarrierPolicy(Enum):
    STREAM = "stream"
    STATUS = "status"
    VALUE = "value"


async def apply_barrier(
    stdout: ByteSource | None,
    io: IOResult,
    policy: BarrierPolicy,
) -> ByteSource | None:
    """Apply a shell-level barrier to finalize a command result.

    Args:
        stdout (ByteSource | None): lazy or materialized stdout stream
        io (IOResult): the IOResult whose exit_code may still be provisional
        policy (BarrierPolicy): which barrier level to enforce

    Returns:
        ByteSource | None: the (possibly transformed) stdout
    """
    if policy is BarrierPolicy.STREAM:
        return stdout
    if policy is BarrierPolicy.STATUS:
        await drain(stdout)
        return None
    # VALUE
    return await materialize(stdout)
