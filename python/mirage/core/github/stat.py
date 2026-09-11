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

import logging

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.github.readdir import readdir as _readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


async def stat(
    accessor: GitHubAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    rel = path_spec.mount_path.strip("/")
    if not rel:
        return FileStat(name="/", type=FileType.DIRECTORY)
    key = prefix + "/" + rel if prefix else "/" + rel
    result = await index.get(key)
    if result.entry is None:
        parent_path = key.rsplit("/", 1)[0] or "/"
        try:
            await _readdir(
                accessor,
                PathSpec(virtual=parent_path,
                         directory=parent_path,
                         resource_path=mount_key(parent_path, prefix)),
                index=index,
            )
        except FileNotFoundError as exc:
            logger.debug("stat populate failed for %s: %s", key, exc)
        result = await index.get(key)
    if result.entry is not None:
        if result.entry.resource_type == "folder":
            return FileStat(
                name=result.entry.name,
                type=FileType.DIRECTORY,
            )
        return FileStat(
            name=result.entry.name,
            size=result.entry.size,
            type=FileType.FILE,
            content=content_type_for_path(result.entry.name),
            fingerprint=result.entry.id,
            extra={"sha": result.entry.id},
        )
    raise enoent(virtual)
