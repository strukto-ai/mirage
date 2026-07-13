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

from mirage.cache.index import IndexCacheStore
from mirage.core.github.readdir import readdir as _readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


async def stat(accessor, path: PathSpec, index: IndexCacheStore) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    virtual = path.virtual
    if isinstance(path, PathSpec):
        prefix = mount_prefix_of(path.virtual, path.resource_path)
        path = path.virtual

    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    if path == "/" or path == "":
        return FileStat(name="/", type=FileType.DIRECTORY)
    key = "/" + path.strip("/") if path.strip("/") else "/"
    result = await index.get(key)
    if result.entry is None:
        parent_idx = key.rsplit("/", 1)[0] or "/"
        parent_path = (prefix + parent_idx) if prefix else parent_idx
        try:
            await _readdir(
                accessor,
                PathSpec(virtual=parent_path,
                         directory=parent_path,
                         resource_path=mount_key(parent_path, prefix)),
                index=index,
            )
        except Exception as exc:
            # best-effort cache populate; canonical ENOENT raised below
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
            type=guess_type(result.entry.name),
            fingerprint=result.entry.id,
            extra={"sha": result.entry.id},
        )
    raise enoent(virtual)
