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

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                ResourceType)
from mirage.core.s3._client import (_client_kwargs, _prefix, _strip_prefix,
                                    async_session)
from mirage.core.s3.constants import SCOPE_ERROR
from mirage.core.timeutil import to_iso_z
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


async def readdir(accessor: S3Accessor,
                  path: PathSpec,
                  index: IndexCacheStore = NULL_INDEX) -> list[str]:
    if isinstance(path, PathSpec):
        prefix = mount_prefix_of(path.virtual, path.resource_path)
        # When called from resolve_glob with a pattern (e.g. *.txt),
        # use path.directory for the listing. Direct callers (ls, ops)
        # pass pattern=None so path.virtual is used.
        path = path.directory if path.pattern else path.virtual
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    config = accessor.config
    raw_key = prefix + path if prefix else path
    virtual_key = raw_key.rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    pfx = _prefix(path, config)
    names: list[str] = []
    dir_keys: set[str] = set()
    sizes: dict[str, int | None] = {}
    times: dict[str, str] = {}
    session = async_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        paginator = client.get_paginator("list_objects_v2")
        async for page in paginator.paginate(Bucket=config.bucket,
                                             Prefix=pfx,
                                             Delimiter="/"):
            for cp in page.get("CommonPrefixes") or []:
                child = cp["Prefix"].rstrip("/")
                if child:
                    key = "/" + _strip_prefix(child, config)
                    names.append(key)
                    dir_keys.add(key)
            for obj in page.get("Contents") or []:
                relative = obj["Key"][len(pfx):]
                if relative and "/" not in relative:
                    key = "/" + _strip_prefix(obj["Key"], config)
                    names.append(key)
                    sizes[key] = obj.get("Size")
                    last_mod = obj.get("LastModified")
                    times[key] = to_iso_z(last_mod) if last_mod else ""
    names = sorted(names)
    if len(names) > SCOPE_ERROR:
        logger.warning(
            "s3 readdir: %s returned %d entries (limit %d)",
            virtual_key,
            len(names),
            SCOPE_ERROR,
        )
    virtual_entries = sorted((prefix + e if prefix else e) for e in names)
    index_entries = []
    for e in names:
        name = e.rsplit("/", 1)[-1]
        if e in dir_keys:
            # S3 "folders" are synthetic common-prefixes with no object
            # of their own, so there is no LastModified or Size to record.
            entry = IndexEntry(id=e,
                               name=name,
                               resource_type=ResourceType.FOLDER)
        else:
            entry = IndexEntry(id=e,
                               name=name,
                               resource_type=ResourceType.FILE,
                               size=sizes.get(e),
                               remote_time=times.get(e, ""))
        index_entries.append((name, entry))
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries
