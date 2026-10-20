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
from collections.abc import AsyncIterator
from contextlib import aclosing

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdocs.read import read_doc
from mirage.core.gdrive import NATIVE_RESOURCE_TYPES
from mirage.core.gdrive.api import DriveApi
from mirage.core.gdrive.fingerprint import drive_fingerprint
from mirage.core.gsheets.read import read_spreadsheet
from mirage.core.gslides.read import read_presentation
from mirage.errors.fs import eisdir, enoent
from mirage.observe.context import (
    active_recorder,
    record,
    record_stream,
    revision_for,
    start_op,
)
from mirage.types import FileStat, FileType, JsonValue, PathSpec
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
    drive: DriveApi,
    file_id: str,
    virtual: str,
    entry: FileStat,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Download a binary file honouring snapshot revision pins.

    A pinned path reads that revision's content. Otherwise the token
    comes from a capture when a recorder is bound and from the listed
    row when none is, so it never depends on the recorder; the row's
    revision is not pinned, since it can be a TTL old. Either md5 is
    checked against the bytes, and a stale one drops the token and the
    revision with it.

    Args:
        drive (DriveApi): the Drive client.
        file_id (str): file ID.
        virtual (str): full virtual path, the pin lookup key and the
            recorded path.
        entry (FileStat): the listed row the file was resolved from.
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
        data = await drive.download_revision(file_id, pinned, window)
    elif active_recorder() is not None:
        md5, revision = await drive.capture_file_metadata(file_id)
        data = await drive.download_file(file_id, window)
        if whole and _stale_md5(md5, data):
            revision = None
        elif whole:
            fingerprint = drive_fingerprint(
                entry.extra["resource_type"], md5, revision, entry.modified
            )
    else:
        data = await drive.download_file(file_id, window)
        if whole and not _stale_md5(entry.extra.get("md5_checksum"), data):
            fingerprint = entry.fingerprint
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


def file_entry(path: PathSpec, entry: FileStat | None) -> FileStat:
    """What is at the file ``path``, as its parent's listing named it.

    Args:
        path (PathSpec): the file.
        entry (FileStat | None): what is at the path.

    Raises:
        FileNotFoundError: nothing is there.
        IsADirectoryError: a folder is.
    """
    if entry is None:
        raise enoent(path.virtual)
    if entry.type is FileType.DIRECTORY:
        raise eisdir(path.virtual)
    return entry


async def read(
    accessor: GDriveAccessor,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
    entry: FileStat | None = None,
) -> bytes:
    """Read a Drive file, optionally only a byte range of it.

    Only a binary file has a remote range to ask for. A google-apps file
    is rendered here into JSON, so its bytes do not exist until we make
    them and the window can only be taken afterwards.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        path (PathSpec): the path to read.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
        entry (FileStat | None): what is at the path.
    """
    virtual = path.virtual
    found = file_entry(path, entry)
    file_id = found.extra["file_id"]
    resource_type = found.extra["resource_type"]
    if resource_type not in NATIVE_RESOURCE_TYPES:
        return await read_file_versioned(
            accessor.drive, file_id, virtual, found, offset, size
        )
    timer = start_op()
    if resource_type == "gdrive/gdoc":
        rendered = await read_doc(accessor.token_manager, file_id)
    elif resource_type == "gdrive/gsheet":
        rendered = await read_spreadsheet(accessor.token_manager, file_id)
    else:
        rendered = await read_presentation(accessor.token_manager, file_id)
    sliced = slice_window(rendered, offset, size)
    # No revision: a pin would replace the drift check a render relies on.
    fingerprint = found.fingerprint if _whole_file(offset, size) else None
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


async def read_stream(
    accessor: GDriveAccessor, path: PathSpec, entry: FileStat | None = None
) -> AsyncIterator[bytes]:
    """Stream a Drive file as it downloads.

    A google-apps file exists only once rendered, so it comes in one
    chunk, as :func:`read` gives it. A binary file is stamped as
    :func:`read_file_versioned` stamps a whole read, once the last chunk
    is in and checked against the md5 Drive gave: a stream abandoned
    part-way stamps nothing.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        path (PathSpec): the path to read.
        entry (FileStat | None): what is at the path.
    """
    found = file_entry(path, entry)
    file_id = found.extra["file_id"]
    if found.extra["resource_type"] in NATIVE_RESOURCE_TYPES:
        yield await read(accessor, path, entry=found)
        return
    drive = accessor.drive
    pinned = revision_for(path.virtual)
    rec = record_stream("read", path.virtual, "gdrive", revision=pinned)
    md5: str | None = None
    revision = None
    if pinned:
        chunks = drive.download_revision_stream(file_id, pinned)
    else:
        if rec is not None:
            md5, revision = await drive.capture_file_metadata(file_id)
        chunks = drive.download_file_stream(file_id)
    digest = hashlib.md5() if md5 else None
    async with aclosing(chunks) as source:
        async for chunk in source:
            if digest is not None:
                digest.update(chunk)
            if rec is not None:
                rec.bytes += len(chunk)
            yield chunk
    if rec is None or pinned:
        return
    if digest is not None and digest.hexdigest() != md5:
        return
    rec.revision = revision
    rec.fingerprint = drive_fingerprint(
        found.extra["resource_type"], md5, revision, found.modified
    )
