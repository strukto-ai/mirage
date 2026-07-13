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

from opendal.exceptions import NotFound

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.hf_buckets.constants import SCOPE_ERROR
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


async def readdir(accessor: HfBucketsAccessor, path: PathSpec,
                  index: IndexCacheStore) -> list[str]:
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    target = path.directory if path.pattern else path.virtual
    if prefix and target.startswith(prefix):
        rest = target[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            target = rest or "/"
    virtual_key = (prefix + target if prefix else target).rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    list_path = target.strip("/")
    list_path = list_path + "/" if list_path else "/"
    op = accessor.operator()
    names: list[str] = []
    dir_keys: set[str] = set()
    sizes: dict[str, int | None] = {}
    try:
        async for entry in await op.list(list_path):
            relative = entry.path
            if not relative or relative == list_path:
                continue
            is_dir = relative.endswith("/")
            base = "/" + relative.rstrip("/")
            names.append(base)
            if is_dir:
                dir_keys.add(base)
            else:
                meta = entry.metadata
                sizes[base] = meta.content_length if meta else None
    except NotFound as exc:
        raise enoent(path) from exc
    names = sorted(names)
    if len(names) > SCOPE_ERROR:
        logger.warning(
            "hf_buckets readdir: %s returned %d entries (limit %d)",
            virtual_key,
            len(names),
            SCOPE_ERROR,
        )
    virtual_entries = sorted((prefix + e if prefix else e) for e in names)
    index_entries: list[tuple[str, IndexEntry]] = []
    for e in names:
        name = e.rsplit("/", 1)[-1]
        if e in dir_keys:
            entry_obj = IndexEntry(id=e, name=name, resource_type="folder")
        else:
            entry_obj = IndexEntry(id=e,
                                   name=name,
                                   resource_type="file",
                                   size=sizes.get(e))
        index_entries.append((name, entry_obj))
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries
