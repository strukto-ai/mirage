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

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                ResourceType)
from mirage.core.gridfs._client import (_prefix, _strip_prefix, iter_latest,
                                        prefix_query)
from mirage.core.gridfs.constants import SCOPE_ERROR
from mirage.core.timeutil import to_iso_z
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


async def readdir(accessor: GridFSAccessor,
                  path_spec: PathSpec,
                  index: IndexCacheStore = NULL_INDEX) -> list[str]:
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    # When called from resolve_glob with a pattern (e.g. *.txt),
    # use path.directory for the listing. Direct callers (ls, ops)
    # pass pattern=None so path.virtual is used.
    path = path_spec.directory if path_spec.pattern else path_spec.virtual
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
    async for doc in iter_latest(accessor, prefix_query(pfx)):
        fname = doc["filename"]
        if fname == pfx:
            continue
        relative = fname[len(pfx):]
        slash = relative.find("/")
        if slash == -1:
            key = "/" + _strip_prefix(fname, config)
            names.append(key)
            sizes[key] = doc["length"]
            upload = doc.get("uploadDate")
            times[key] = to_iso_z(upload) if upload else ""
        else:
            # A deeper filename or a "seg/" directory marker both imply an
            # immediate child directory (S3 CommonPrefixes equivalent).
            child = pfx + relative[:slash]
            key = "/" + _strip_prefix(child, config)
            if key not in dir_keys:
                names.append(key)
                dir_keys.add(key)
    names = sorted(names)
    if len(names) > SCOPE_ERROR:
        logger.warning(
            "gridfs readdir: %s returned %d entries (limit %d)",
            virtual_key,
            len(names),
            SCOPE_ERROR,
        )
    virtual_entries = sorted((prefix + e if prefix else e) for e in names)
    index_entries = []
    for e in names:
        name = e.rsplit("/", 1)[-1]
        if e in dir_keys:
            # GridFS "folders" are synthetic prefixes with no file doc of
            # their own, so there is no uploadDate or length to record.
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
