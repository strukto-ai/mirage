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
import time

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.gdocs.read import read_doc
from mirage.core.gdrive import DIRECTORY_RESOURCE_TYPES
from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.versions import (capture_file_metadata,
                                         download_revision)
from mirage.core.google._client import TokenManager
from mirage.core.google.drive import download_file
from mirage.core.gsheets.read import read_spreadsheet
from mirage.core.gslides.read import read_presentation
from mirage.observe.context import active_recorder, record, revision_for
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


async def read_bytes(
    token_manager: TokenManager,
    file_id: str,
) -> bytes:
    return await download_file(token_manager, file_id)


async def read_file_versioned(token_manager: TokenManager, file_id: str,
                              virtual: str, label: str) -> bytes:
    """Download a binary file honouring snapshot revision pins.

    A pinned path reads that revision's content; an actively recorded read
    captures (fingerprint, revision) so snapshots can pin it later,
    mirroring the msgraph read_item.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
        virtual (str): full virtual path (pin lookup key).
        label (str): mount-relative path recorded with the read.
    """
    pinned = revision_for(virtual)
    start_ms = int(time.monotonic() * 1000)
    fingerprint = None
    revision = pinned
    if pinned:
        data = await download_revision(token_manager, file_id, pinned)
    elif active_recorder() is not None:
        fingerprint, revision = await capture_file_metadata(
            token_manager, file_id)
        data = await download_file(token_manager, file_id)
    else:
        data = await download_file(token_manager, file_id)
    record("read",
           label,
           "gdrive",
           len(data),
           start_ms,
           fingerprint=fingerprint,
           revision=revision)
    return data


async def read(
    accessor: GDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None:
        # cold index: list the parent directory to populate the entry,
        # then retry
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
    if result.entry.resource_type in DIRECTORY_RESOURCE_TYPES:
        raise IsADirectoryError(virtual)
    if result.entry.resource_type == "gdrive/gdoc":
        return await read_doc(accessor.token_manager, result.entry.id)
    if result.entry.resource_type == "gdrive/gsheet":
        return await read_spreadsheet(accessor.token_manager, result.entry.id)
    if result.entry.resource_type == "gdrive/gslide":
        return await read_presentation(accessor.token_manager, result.entry.id)
    return await read_file_versioned(accessor.token_manager, result.entry.id,
                                     virtual, key)
