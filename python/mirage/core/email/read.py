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

import json
import posixpath

from mirage.accessor.email import EmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.email._client import fetch_attachment, fetch_message
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of


async def read(
    accessor: EmailAccessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None:
        raise enoent(virtual)
    if result.entry.resource_type in ("email/folder", "email/date",
                                      "email/attachment_dir"):
        raise IsADirectoryError(virtual)
    if result.entry.resource_type == "email/attachment":
        parent_key = posixpath.dirname(virtual_key)
        parent_result = await index.get(parent_key)
        if parent_result.entry is None:
            raise enoent(virtual)
        uid = parent_result.entry.id
        parts = virtual_key.strip("/").split("/")
        folder = parts[1] if prefix else parts[0]
        filename = result.entry.vfs_name
        data = await fetch_attachment(accessor, folder, uid, filename)
        if data is None:
            raise enoent(virtual)
        return data
    parts = virtual_key.strip("/").split("/")
    folder = parts[1] if prefix else parts[0]
    uid = result.entry.id
    msg = await fetch_message(accessor, folder, uid)
    return json.dumps(msg, ensure_ascii=False, separators=(",", ":")).encode()
