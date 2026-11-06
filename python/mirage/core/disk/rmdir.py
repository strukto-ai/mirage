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
from mirage.core.disk.errors import disk_errors
from mirage.core.disk.utils import resolve_inside_sync
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def rmdir(
    accessor: DiskAccessor,
    path_spec: PathSpec,
) -> None:
    def remove() -> None:
        p = resolve_inside_sync(accessor.root, path_spec)
        with disk_errors(path_spec.virtual):
            os.rmdir(p)

    timer = start_op()
    done = True
    try:
        await run_blocking(remove)
    except Exception:
        done = False
        raise
    finally:
        # A refused rmdir(2) removed nothing; a cancelled wait may not have
        # stopped the worker's.
        if done:
            record("rmdir", path_spec.virtual, "disk", 0, timer)
