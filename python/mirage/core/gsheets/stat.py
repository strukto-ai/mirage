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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gsheets.readdir import readdir as _readdir
from mirage.types import FileStat, FileType, PathSpec

VIRTUAL_DIRS = {"", "owned", "shared"}


async def stat(
    accessor: GSheetsAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original

    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    key = path.strip("/")
    if key in VIRTUAL_DIRS:
        name = key if key else "/"
        return FileStat(name=name, type=FileType.DIRECTORY)
    if index is None:
        raise FileNotFoundError(path)
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None:
        parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
        try:
            await _readdir(
                accessor,
                PathSpec(original=parent_virtual,
                         directory=parent_virtual,
                         prefix=prefix),
                index=index,
            )
        # best-effort cache populate; canonical ENOENT raised below
        except Exception:
            pass
        result = await index.get(virtual_key)
        if result.entry is None:
            raise FileNotFoundError(path)
    return FileStat(
        name=result.entry.vfs_name,
        type=FileType.JSON,
        modified=result.entry.remote_time,
        size=result.entry.size,
        extra={
            "doc_id": result.entry.id,
            "doc_name": result.entry.name,
        },
    )
