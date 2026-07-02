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

from mirage.accessor.qdrant import QdrantAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.qdrant.query import table_exists
from mirage.core.qdrant.read import read
from mirage.core.qdrant.scope import ScopeLevel, detect_scope
from mirage.types import FileStat, FileType, PathSpec

_IMAGE_TYPES = {
    "png": FileType.IMAGE_PNG,
    "jpg": FileType.IMAGE_JPEG,
    "jpeg": FileType.IMAGE_JPEG,
    "gif": FileType.IMAGE_GIF,
}


def _name_of(path: PathSpec) -> str:
    stripped = path.virtual.rstrip("/")
    return stripped.rsplit("/", 1)[-1] or "/"


async def stat(
    accessor: QdrantAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    config = accessor.config
    scope = detect_scope(path, config)

    if scope.level == ScopeLevel.UNKNOWN:
        raise FileNotFoundError(path.virtual)

    if scope.table and not await table_exists(accessor, scope.table):
        raise FileNotFoundError(path.virtual)

    if scope.level in (ScopeLevel.ROOT, ScopeLevel.GROUP_DIR):
        return FileStat(name=_name_of(path), type=FileType.DIRECTORY)

    data = await read(accessor, path, index)
    if scope.kind == "blob":
        file_type = _IMAGE_TYPES.get(config.blob_ext, FileType.BINARY)
    else:
        file_type = FileType.TEXT
    return FileStat(name=_name_of(path), size=len(data), type=file_type)
