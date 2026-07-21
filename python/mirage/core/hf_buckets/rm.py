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

import time

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.context import invalidate_after_unlink, invalidate_ancestors
from mirage.observe.context import record
from mirage.types import PathSpec


async def rm_r(accessor: HfBucketsAccessor, path_spec: PathSpec) -> None:
    """Recursively delete every object under a prefix.

    Args:
        accessor (HfBucketsAccessor): HF bucket accessor.
        path_spec (PathSpec): Prefix path_spec.
    """
    raw = path_spec.mount_path
    scan_path = raw.strip("/")
    scan_path = scan_path + "/" if scan_path else "/"
    op = accessor.operator()
    start_ms = int(time.monotonic() * 1000)
    keys = [
        entry.path async for entry in await op.scan(scan_path)
        if not entry.path.endswith("/")
    ]
    for key in keys:
        await op.delete(key)
    record("rm_r", path_spec.virtual, accessor.RESOURCE_NAME, 0, start_ms)
    await invalidate_after_unlink(path_spec)
    await invalidate_ancestors(path_spec)
