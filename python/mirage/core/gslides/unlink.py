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

from mirage.accessor.gslides import GSlidesAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.cache.index import IndexCacheStore
from mirage.core.google.drive import delete_file
from mirage.core.gslides.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

VIRTUAL_DIRS = {"", "owned", "shared"}


async def unlink(
    accessor: GSlidesAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> None:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    raw = path.virtual
    stripped = raw[len(prefix):] if prefix and raw.startswith(prefix) else raw
    key = stripped.strip("/")
    if key in VIRTUAL_DIRS:
        raise IsADirectoryError(raw)
    if index is None:
        raise enoent(path)
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None:
        parent = "/" + "/".join(key.split("/")[:-1])
        parent_path = PathSpec.from_str_path(
            prefix + parent, mount_key(prefix + parent, prefix))
        await readdir(accessor, parent_path, index)
        result = await index.get(virtual_key)
    if result.entry is None:
        raise enoent(path)
    await delete_file(accessor.token_manager, result.entry.id)
    parent_dir = "/".join(virtual_key.rsplit("/", 1)[:-1]) or "/"
    await index.invalidate_dir(parent_dir)
    await invalidate_after_unlink(virtual_key)
