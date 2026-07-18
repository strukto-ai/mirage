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

from mirage.accessor.gslides import GSlidesAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.gslides._client import (SLIDES_API_BASE, TokenManager,
                                         google_get)
from mirage.core.gslides.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


async def read_presentation(token_manager: TokenManager,
                            presentation_id: str) -> bytes:
    url = f"{SLIDES_API_BASE}/presentations/{presentation_id}"
    data = await google_get(token_manager, url)
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()


async def read(
    accessor: GSlidesAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
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
            except FileNotFoundError as exc:
                logger.debug("read populate failed for %s: %s", virtual_key,
                             exc)
        if result.entry is None:
            raise enoent(virtual)
    if result.entry.resource_type in ("gslides/directory", ):
        raise IsADirectoryError(virtual)
    return await read_presentation(accessor.token_manager, result.entry.id)
