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
import logging
import posixpath

from mirage.accessor.gmail import GmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gmail.messages import get_attachment, get_message_processed
from mirage.core.gmail.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


async def read(
    accessor: GmailAccessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None:
        parent_key = posixpath.dirname(virtual_key) or "/"
        if parent_key != virtual_key:
            parent_path = PathSpec.from_str_path(parent_key,
                                                 mount_key(parent_key, prefix))
            try:
                await readdir(accessor, parent_path, index)
                result = await index.get(virtual_key)
            except Exception as exc:
                # best-effort cache populate; canonical ENOENT raised below
                logger.debug("read populate failed for %s: %s", virtual_key,
                             exc)
        if result.entry is None:
            raise enoent(virtual)
    if result.entry.resource_type in ("gmail/label", "gmail/date",
                                      "gmail/attachment_dir"):
        raise IsADirectoryError(virtual)
    if result.entry.resource_type == "gmail/attachment":
        att_dir_key = posixpath.dirname(virtual_key)
        att_dir_result = await index.get(att_dir_key)
        if att_dir_result.entry is None:
            raise enoent(virtual)
        message_id = att_dir_result.entry.id
        attachment_id = result.entry.id
        return await get_attachment(accessor.token_manager, message_id,
                                    attachment_id)
    processed = await get_message_processed(accessor.token_manager,
                                            result.entry.id)
    return json.dumps(processed, ensure_ascii=False,
                      separators=(",", ":")).encode()
