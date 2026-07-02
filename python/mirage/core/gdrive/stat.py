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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gdrive import DIRECTORY_RESOURCE_TYPES
from mirage.core.gdrive.readdir import readdir as _readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def stat(
    accessor: GDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)
    if index is None:
        raise enoent(virtual)
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None:
        parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
        try:
            await _readdir(
                accessor,
                PathSpec(virtual=parent_virtual,
                         directory=parent_virtual,
                         resource_path=mount_key(parent_virtual, prefix)),
                index=index,
            )
        # best-effort cache populate; canonical ENOENT raised below
        except Exception:
            pass
        result = await index.get(virtual_key)
        if result.entry is None:
            raise enoent(virtual)
    if result.entry.resource_type in DIRECTORY_RESOURCE_TYPES:
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.DIRECTORY,
            modified=result.entry.remote_time,
            extra={"file_id": result.entry.id},
        )
    return FileStat(
        name=result.entry.vfs_name or result.entry.name,
        size=result.entry.size,
        type=guess_type(result.entry.vfs_name),
        modified=result.entry.remote_time,
        fingerprint=result.entry.remote_time or None,
        extra={
            "file_id": result.entry.id,
            "resource_type": result.entry.resource_type,
        },
    )
