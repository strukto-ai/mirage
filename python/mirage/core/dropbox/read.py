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
import posixpath
from collections.abc import AsyncIterator

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.dropbox._client import (DropboxApiError, dropbox_download,
                                         dropbox_download_stream)
from mirage.core.dropbox.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


def dropbox_path_from_virtual(root: str, virtual_key: str, prefix: str) -> str:
    key = virtual_key
    if prefix and key.startswith(prefix):
        key = key[len(prefix):]
    key = key.strip("/")
    return root if not key else f"{root}/{key}"


async def _resolve_entry(
    accessor: DropboxAccessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> tuple[IndexEntry, str, str]:
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    p = path.virtual
    if prefix and p.startswith(prefix):
        p = p[len(prefix):] or "/"
    key = p.strip("/")
    if not key:
        raise IsADirectoryError(path.virtual)
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
            except (FileNotFoundError, DropboxApiError) as exc:
                # Parent listing failed (missing dir surfaces as a 409
                # from the API): fall through to enoent like the TS read.
                logger.debug("read populate failed for %s: %s", virtual_key,
                             exc)
        if result.entry is None:
            raise enoent(path.virtual)
    if result.entry.resource_type == "dropbox/folder":
        raise IsADirectoryError(path.virtual)
    return result.entry, virtual_key, prefix


async def read(
    accessor: DropboxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    if index is NULL_INDEX:
        # Index-less callers (the ops factory's emulated truncate)
        # download directly; the API 409s on missing paths and folders.
        prefix = mount_prefix_of(path.virtual, path.resource_path)
        dropbox_path = dropbox_path_from_virtual(accessor.root_path,
                                                 path.virtual, prefix)
        try:
            return await dropbox_download(accessor.token_manager, dropbox_path)
        except DropboxApiError as exc:
            if exc.status == 409:
                raise enoent(path.virtual) from exc
            raise
    _, virtual_key, prefix = await _resolve_entry(accessor, path, index)
    dropbox_path = dropbox_path_from_virtual(accessor.root_path, virtual_key,
                                             prefix)
    return await dropbox_download(accessor.token_manager, dropbox_path)


async def stream(
    accessor: DropboxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    _, virtual_key, prefix = await _resolve_entry(accessor, path, index)
    dropbox_path = dropbox_path_from_virtual(accessor.root_path, virtual_key,
                                             prefix)
    async for chunk in dropbox_download_stream(accessor.token_manager,
                                               dropbox_path):
        yield chunk
