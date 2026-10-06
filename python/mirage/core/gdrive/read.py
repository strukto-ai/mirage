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

import hashlib
import posixpath
from functools import partial

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.cache.index.warm import entry_or_warm
from mirage.core.gdocs.read import read_doc
from mirage.core.gdrive import DIRECTORY_RESOURCE_TYPES, NATIVE_RESOURCE_TYPES
from mirage.core.gdrive.fingerprint import drive_fingerprint, entry_fingerprint
from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.versions import (
    capture_file_metadata,
    download_revision,
)
from mirage.core.google.client import TokenManager
from mirage.core.google.drive import download_file
from mirage.core.gsheets.read import read_spreadsheet
from mirage.core.gslides.read import read_presentation
from mirage.errors.fs import enoent
from mirage.observe.context import (
    active_recorder,
    record,
    revision_for,
    start_op,
)
from mirage.types import JsonValue, PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.ranges import slice_window, window_for


def _whole_file(offset: int, size: int | None) -> bool:
    """Whether a read returned the whole object rather than a window.

    A token describes the whole object, so a window stamped with one
    would read as fresh for the life of the entry.

    Args:
        offset (int): first byte the caller asked for.
        size (int | None): how many bytes, or None for the rest.
    """
    return offset == 0 and size is None


def _stale_md5(md5: JsonValue, data: bytes) -> bool:
    """Whether Drive's md5 names other bytes than the ones just read.

    The metadata and the download are two requests, so a write between
    them leaves metadata that predates the bytes.

    Args:
        md5 (JsonValue): Drive's ``md5Checksum`` for the file.
        data (bytes): the whole file as downloaded.
    """
    return (
        isinstance(md5, str)
        and bool(md5)
        and hashlib.md5(data).hexdigest() != md5
    )


async def read_file_versioned(
    token_manager: TokenManager,
    file_id: str,
    virtual: str,
    entry: IndexEntry,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Download a binary file honouring snapshot revision pins.

    A pinned path reads that revision's content. Otherwise the token
    comes from a capture when a recorder is bound and from the index
    entry when none is, so it never depends on the recorder; the
    entry's revision is not pinned, since it can be a TTL old. Either
    md5 is checked against the bytes, and a stale one drops the token
    and the revision with it.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
        virtual (str): full virtual path, the pin lookup key and the
            recorded path.
        entry (IndexEntry): the index entry the file was resolved from.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    pinned = revision_for(virtual)
    window = window_for(offset, size)
    whole = _whole_file(offset, size)
    timer = start_op()
    fingerprint = None
    revision = pinned
    if pinned:
        data = await download_revision(token_manager, file_id, pinned, window)
    elif active_recorder() is not None:
        md5, revision = await capture_file_metadata(token_manager, file_id)
        data = await download_file(token_manager, file_id, window)
        if whole and _stale_md5(md5, data):
            revision = None
        elif whole:
            fingerprint = drive_fingerprint(
                entry.resource_type, md5, revision, entry.remote_time
            )
    else:
        data = await download_file(token_manager, file_id, window)
        if whole and not _stale_md5(entry.extra.get("md5_checksum"), data):
            fingerprint = entry_fingerprint(entry)
    record(
        "read",
        virtual,
        "gdrive",
        len(data),
        timer,
        fingerprint=fingerprint,
        revision=revision,
    )
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
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    key = path.vfs_path
    virtual_key = prefix + "/" + key if prefix else "/" + key
    parent_key = posixpath.dirname(virtual_key) or "/"
    parent_path = PathSpec.from_str_path(
        parent_key, mount_key(parent_key, prefix)
    )
    warm = (
        partial(readdir, accessor, parent_path, index)
        if parent_key != virtual_key
        else None
    )
    entry = await entry_or_warm(index, virtual_key, warm)
    if entry is None:
        raise enoent(virtual)
    if entry.resource_type in DIRECTORY_RESOURCE_TYPES:
        raise IsADirectoryError(virtual)
    if entry.resource_type not in NATIVE_RESOURCE_TYPES:
        return await read_file_versioned(
            accessor.token_manager, entry.id, virtual, entry, offset, size
        )
    timer = start_op()
    if entry.resource_type == "gdrive/gdoc":
        rendered = await read_doc(accessor.token_manager, entry.id)
    elif entry.resource_type == "gdrive/gsheet":
        rendered = await read_spreadsheet(accessor.token_manager, entry.id)
    else:
        rendered = await read_presentation(accessor.token_manager, entry.id)
    sliced = slice_window(rendered, offset, size)
    # No revision: a pin would replace the drift check a render relies on.
    fingerprint = (
        entry_fingerprint(entry) if _whole_file(offset, size) else None
    )
    record(
        "read",
        virtual,
        "gdrive",
        len(sliced),
        timer,
        fingerprint=fingerprint,
        revision=None,
    )
    return sliced
