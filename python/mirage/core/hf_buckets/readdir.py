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

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.hf_buckets._client import (HfBucketsClient, _prefix,
                                            _strip_prefix, _tree_url)
from mirage.core.hf_buckets.constants import SCOPE_ERROR
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def readdir(accessor: HfBucketsAccessor, path: PathSpec,
                  index: IndexCacheStore) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    prefix = path.prefix
    target = path.directory if path.pattern else path.original
    if prefix and target.startswith(prefix):
        rest = target[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            target = rest or "/"
    config = accessor.config
    raw_key = prefix + target if prefix else target
    virtual_key = raw_key.rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    pfx = _prefix(target, config).rstrip("/")
    client = HfBucketsClient(config)
    bucket_id = await client.bucket_id()
    url = _tree_url(config.endpoint, bucket_id, pfx)
    async with await client.session() as session:
        async with session.get(url) as resp:
            resp.raise_for_status()
            entries_json = await resp.json()
    names: list[str] = []
    dir_keys: set[str] = set()
    sizes: dict[str, int | None] = {}
    for entry in entries_json:
        bucket_key = entry.get("path", "")
        if not bucket_key:
            continue
        key = "/" + _strip_prefix(bucket_key, config)
        names.append(key)
        if entry.get("type") == "directory":
            dir_keys.add(key)
        else:
            sizes[key] = entry.get("size")
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
