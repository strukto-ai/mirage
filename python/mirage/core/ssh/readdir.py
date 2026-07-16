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

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.ssh._client import _abs
from mirage.core.ssh.constants import SCOPE_ERROR
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


async def readdir(accessor: SSHAccessor,
                  path_spec: PathSpec,
                  index: IndexCacheStore = NULL_INDEX) -> list[str]:
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    path = path_spec.directory if path_spec.pattern else path_spec.virtual
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    config = accessor.config
    # Canonical key: no trailing slash (except root), or the same dir
    # indexes under two keys and cache hits return doubled-slash entries.
    virtual_key = prefix + path if prefix else path
    virtual_key = virtual_key.rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    sftp = await accessor.sftp()
    try:
        remote_path = _abs(config, path)
        entries = await sftp.readdir(remote_path)
        base = "/" + path.strip("/")
        names: list[str] = []
        for entry in entries:
            name = entry.filename
            if isinstance(name, bytes):
                name = name.decode()
            if name in (".", ".."):
                continue
            child = base.rstrip("/") + "/" + name
            names.append(child)
        names = sorted(names)
        if len(names) > SCOPE_ERROR:
            logger.warning(
                "ssh readdir: %s returned %d entries (limit %d)",
                virtual_key,
                len(names),
                SCOPE_ERROR,
            )
        virtual_entries = sorted((prefix + e if prefix else e) for e in names)
        index_entries = [(e.rsplit("/", 1)[-1],
                          IndexEntry(id=e,
                                     name=e.rsplit("/", 1)[-1],
                                     resource_type="file")) for e in names]
        await index.set_dir(virtual_key, index_entries)
        return virtual_entries
    except asyncssh.SFTPNoSuchFile:
        raise enoent(virtual)
