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

from opendal.exceptions import NotFound

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.cache.index import IndexCacheStore
from mirage.core.hf_buckets.stat import stat
from mirage.observe.context import record
from mirage.types import FileType, PathSpec
from mirage.utils.errors import enoent


async def unlink(accessor: HfBucketsAccessor,
                 path: PathSpec,
                 index: IndexCacheStore | None = None) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    file_stat = await stat(accessor, path, index)
    if file_stat.type == FileType.DIRECTORY:
        raise IsADirectoryError(path.mount_path)
    raw = path.mount_path
    key = raw.lstrip("/")
    op = accessor.operator()
    start_ms = int(time.monotonic() * 1000)
    try:
        await op.delete(key)
    except NotFound as exc:
        raise enoent(path) from exc
    record("unlink", path.virtual, accessor.RESOURCE_NAME, 0, start_ms)
    await invalidate_after_unlink(path)
