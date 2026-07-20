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

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.gridfs._client import (_key, delete_all, files_coll,
                                        latest_file)
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def rename(accessor: GridFSAccessor, src_spec: PathSpec,
                 dst_spec: PathSpec) -> None:
    # Server-side: retag every revision's filename instead of copying
    # bytes, so the whole revision history moves with the file.
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    config = accessor.config
    src_key = _key(src, config)
    dst_key = _key(dst, config)
    if await latest_file(accessor, src_key) is None:
        raise enoent(src_spec.virtual)
    await delete_all(accessor, {"filename": dst_key})
    await files_coll(accessor).update_many({"filename": src_key},
                                           {"$set": {
                                               "filename": dst_key
                                           }})
    await invalidate_after_write(dst_spec)
    await invalidate_after_unlink(src_spec)
