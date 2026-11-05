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


import os

from mirage.accessor.disk import DiskAccessor
from mirage.concurrency.limiter import run_blocking
from mirage.core.disk.utils import resolve_inside_sync
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def rename(
    accessor: DiskAccessor, src_spec: PathSpec, dst_spec: PathSpec
) -> None:
    root = accessor.root
    folder = False

    def move() -> None:
        nonlocal folder
        src = resolve_inside_sync(root, src_spec)
        dst = resolve_inside_sync(root, dst_spec)
        # Named as the object stores name it: a moved directory took its
        # subtree, which only "rename_prefix" retracts. Asked before the
        # move, so nothing awaits between the move and its records.
        folder = os.path.isdir(src)
        os.rename(src, dst)

    timer = start_op()
    done = True
    try:
        await run_blocking(move)
    except Exception:
        done = False
        raise
    finally:
        # A refused rename(2) moved nothing; a cancelled wait may not have
        # stopped the worker's.
        if done:
            op = "rename_prefix" if folder else "rename"
            record(op, src_spec.virtual, "disk", 0, timer)
            record(op, dst_spec.virtual, "disk", 0, timer)
