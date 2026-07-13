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

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import IndexCacheStore
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type
from mirage.utils.path import norm


async def stat(
    accessor: RedisAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    virtual = path.virtual
    if isinstance(path, PathSpec):
        path = path.mount_path
    store = accessor.store
    p = norm(path)
    if await store.has_dir(p):
        return FileStat(
            name=p.rsplit("/", 1)[-1] or "/",
            size=None,
            modified=await store.get_modified(p),
            type=FileType.DIRECTORY,
        )
    if await store.has_file(p):
        size = await store.file_len(p)
        return FileStat(
            name=p.rsplit("/", 1)[-1],
            size=size,
            modified=await store.get_modified(p),
            type=guess_type(p),
        )
    raise enoent(virtual)
