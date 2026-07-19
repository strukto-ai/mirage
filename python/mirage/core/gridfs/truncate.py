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
from mirage.cache.context import invalidate_after_write
from mirage.core.gridfs._client import _key, bucket, latest_file
from mirage.types import PathSpec


async def truncate(accessor: GridFSAccessor, path_spec: PathSpec,
                   length: int) -> None:
    path = path_spec.mount_path
    config = accessor.config
    key = _key(path, config)
    doc = await latest_file(accessor, key)
    if doc is None:
        data = b""
    else:
        b = bucket(accessor)
        out = await b.open_download_stream(doc["_id"])
        try:
            data = await out.read(-1)
        finally:
            await out.close()
    result = data[:length].ljust(length, b"\0")
    await bucket(accessor).upload_from_stream(key, result)
    await invalidate_after_write(path_spec)
