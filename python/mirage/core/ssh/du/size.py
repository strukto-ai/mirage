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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.ssh.du.walk import walk
from mirage.core.ssh.stat import stat
from mirage.types import FileType, PathSpec


async def size(accessor: SSHAccessor,
               path: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> int:
    """Recursive byte size of everything under a path.

    Args:
        accessor (SSHAccessor): SSH accessor.
        path (PathSpec): target path.
    """
    try:
        info = await stat(accessor, path, index=index)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return info.size or 0
    sftp = await accessor.sftp()
    return await walk(sftp, accessor.config, path.mount_path, None)
