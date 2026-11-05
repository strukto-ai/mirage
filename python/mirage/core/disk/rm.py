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
import shutil

from mirage.accessor.disk import DiskAccessor
from mirage.concurrency.limiter import run_blocking
from mirage.core.disk.utils import resolve_inside
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def rm_r(accessor: DiskAccessor, path_spec: PathSpec) -> None:
    p = await resolve_inside(accessor.root, path_spec)
    timer = start_op()

    def remove() -> None:
        if os.path.isdir(p):
            shutil.rmtree(p)
        elif os.path.exists(p):
            os.remove(p)

    try:
        await run_blocking(remove)
    finally:
        # Also when the walk raised: rmtree that fails part-way has
        # already removed entries, as on the object stores.
        record("rm_r", path_spec.virtual, "disk", 0, timer)
