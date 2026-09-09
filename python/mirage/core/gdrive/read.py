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

import posixpath
from functools import partial

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.warm import entry_or_warm
from mirage.core.gdocs.read import read_doc
from mirage.core.gdrive import DIRECTORY_RESOURCE_TYPES
from mirage.core.gdrive.api import DriveApi
from mirage.core.gdrive.readdir import readdir
from mirage.core.gsheets.read import read_spreadsheet
from mirage.core.gslides.read import read_presentation
from mirage.observe.context import (active_recorder, record, revision_for,
                                    start_op)
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.ranges import slice_window, window_for


async def read_bytes(
    drive: DriveApi,
    file_id: str,
) -> bytes:
    return await drive.download_file(file_id)


async def read_file_versioned(drive: DriveApi,
                              file_id: str,
                              virtual: str,
                              label: str,
                              offset: int = 0,
                              size: int | None = None) -> bytes:
    """Download a binary file honouring snapshot revision pins.

    A pinned path reads that revision's content; an actively recorded read
    captures (fingerprint, revision) so snapshots can pin it later,
    mirroring the msgraph read_item.

    Args:
        drive (DriveApi): the accessor's Drive door.
        file_id (str): file ID.
        virtual (str): full virtual path (pin lookup key).
        label (str): mount-relative path recorded with the read.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    pinned = revision_for(virtual)
    window = window_for(offset, size)
    timer = start_op()
    fingerprint = None
    revision = pinned
    if pinned:
        data = await drive.download_revision(file_id, pinned, window)
    elif active_recorder() is not None:
        fingerprint, revision = await drive.capture_file_metadata(file_id)
        data = await drive.download_file(file_id, window)
    else:
        data = await drive.download_file(file_id, window)
    record("read",
           label,
           "gdrive",
           len(data),
           timer,
           fingerprint=fingerprint,
           revision=revision)
    return data


async def read(
    accessor: GDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a Drive file, optionally only a byte range of it.

    Only a binary file has a remote range to ask for. A google-apps file
    is rendered here into JSON, so its bytes do not exist until we make
    them and the window can only be taken afterwards.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): listing cache, consulted for the file id.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    virtual_key = prefix + "/" + key if prefix else "/" + key
    parent_key = posixpath.dirname(virtual_key) or "/"
    parent_path = PathSpec.from_str_path(parent_key,
                                         mount_key(parent_key, prefix))
    warm = (partial(readdir, accessor, parent_path, index)
            if parent_key != virtual_key else None)
    entry = await entry_or_warm(index, virtual_key, warm)
    if entry is None:
        raise enoent(virtual)
    if entry.resource_type in DIRECTORY_RESOURCE_TYPES:
        raise IsADirectoryError(virtual)
    if entry.resource_type == "gdrive/gdoc":
        rendered = await read_doc(accessor.token_manager, entry.id)
    elif entry.resource_type == "gdrive/gsheet":
        rendered = await read_spreadsheet(accessor.token_manager, entry.id)
    elif entry.resource_type == "gdrive/gslide":
        rendered = await read_presentation(accessor.token_manager, entry.id)
    else:
        return await read_file_versioned(accessor.drive, entry.id, virtual,
                                         key, offset, size)
    return slice_window(rendered, offset, size)
