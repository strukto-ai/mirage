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
from typing import Any

import aiohttp

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.fingerprint import drive_fingerprint
from mirage.core.gdrive.resolve import root_context
from mirage.core.google.drive import FOLDER_MIME, MIME_TO_EXT
from mirage.errors.fs import enoent, enotdir
from mirage.types import DirListing, FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path

logger = logging.getLogger(__name__)

_RESOURCE_TYPES = {
    FOLDER_MIME: "gdrive/folder",
    "application/vnd.google-apps.document": "gdrive/gdoc",
    "application/vnd.google-apps.spreadsheet": "gdrive/gsheet",
    "application/vnd.google-apps.presentation": "gdrive/gslide",
}


def unique_shared_drive_name(name: str, existing_names: set[str]) -> str:
    if name not in existing_names:
        return name
    filename = f"{name} [Shared Drive]"
    suffix = 2
    while filename in existing_names:
        filename = f"{name} [Shared Drive {suffix}]"
        suffix += 1
    return filename


def resource_type_for(mime: str) -> str:
    """The gdrive resource type of a Drive MIME type.

    Args:
        mime (str): the item's ``mimeType``.
    """
    return _RESOURCE_TYPES.get(mime, "gdrive/file")


def stat_from_item(item: dict[str, Any]) -> FileStat:
    """The stat of one Drive file resource, as a listing, ``files.get``
    or an upload's reply returns it.

    Pure, so an upload's reply parses the same as a stat. A missing
    ``mimeType`` reads as a plain file: natives are refused before any
    upload, so a reply without one names bytes. ``extra`` carries what
    the functions handed the stat act on: the file id, its shared drive,
    its MIME type, the folders it was filed in, and the md5 and head
    revision a read checks.

    Args:
        item (dict[str, Any]): a Drive file resource with ``ITEM_FIELDS``.
    """
    name = item.get("name", "")
    mime = item.get("mimeType") or ""
    modified = item.get("modifiedTime", "")
    extra: dict[str, Any] = {"file_id": item.get("id"), "mime_type": mime}
    if item.get("driveId"):
        extra["drive_id"] = item["driveId"]
    if item.get("parents"):
        extra["parents"] = list(item["parents"])
    if mime == FOLDER_MIME:
        return FileStat(
            name=name, type=FileType.DIRECTORY, modified=modified, extra=extra
        )
    resource_type = resource_type_for(mime)
    ext = MIME_TO_EXT.get(mime)
    vfs_name = f"{name}{ext}" if ext else name
    if item.get("md5Checksum"):
        extra["md5_checksum"] = item["md5Checksum"]
    if item.get("headRevisionId"):
        extra["head_revision_id"] = item["headRevisionId"]
    # Binary files download raw, so Drive's size is the rendered byte
    # length. Google-apps files render to JSON, so Drive's source size
    # must not become FileStat.size (see the CLAUDE.md FUSE rules); it
    # lives in extra instead.
    source_size = int(item.get("size") or item.get("quotaBytesUsed") or 0)
    if ext and source_size:
        extra["source_size"] = source_size
    size = (
        int(item["size"]) if not ext and item.get("size") is not None else None
    )
    return FileStat(
        name=vfs_name,
        size=size,
        type=FileType.FILE,
        content=content_type_for_path(vfs_name),
        modified=modified,
        fingerprint=drive_fingerprint(
            resource_type,
            item.get("md5Checksum"),
            item.get("headRevisionId"),
            modified,
        ),
        extra={**extra, "resource_type": resource_type},
    )


async def live_row(
    accessor: GDriveAccessor, path: PathSpec, entry: FileStat | None
) -> FileStat | None:
    """What is at ``path`` now, for a change about to be made to it.

    A listed row names its item by id, and another client may have moved,
    renamed or trashed the item since: a change made by that id would land
    on a file at another path. One ``files.get`` confirms the item still
    has the name and the folders the listing gave it; otherwise that folder
    is listed again, and what it names at the path answers, None for
    nothing. A row that names no folder (a Shared Drive) is taken as is.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        path (PathSpec): the path about to change.
        entry (FileStat | None): what its folder's listing named there.
    """
    folders = None if entry is None else entry.extra.get("parents")
    if entry is None or not folders:
        return entry
    drive = accessor.drive
    try:
        item = await drive.get_file(entry.extra["file_id"])
    except aiohttp.ClientResponseError as exc:
        if exc.status != 404:
            raise
        logger.debug("listed id for %s is gone: %s", path.virtual, exc)
    else:
        row = stat_from_item(item)
        if (
            not item.get("trashed")
            and row.name == entry.name
            and row.extra.get("parents") == folders
        ):
            return row
    files = await drive.list_files(
        folder_id=folders[0], drive_id=entry.extra.get("drive_id")
    )
    return next(
        (row for row in map(stat_from_item, files) if row.name == entry.name),
        None,
    )


async def readdir(
    accessor: GDriveAccessor,
    path_spec: PathSpec,
    entry: FileStat | None = None,
) -> list[FileStat] | DirListing:
    """A folder's children, each as ``stat`` answers it.

    The mount root lists the scoped folder, or My Drive and the Shared
    Drives the account sees; any other folder is listed by the id its
    parent's listing named.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        path_spec (PathSpec): the folder.
        entry (FileStat | None): what is at the folder.
    """
    target = path_spec.dir if path_spec.pattern else path_spec
    if not target.vfs_path.strip("/"):
        folder_id, drive_id = await root_context(accessor)
    elif entry is None:
        raise enoent(path_spec.virtual)
    elif entry.type is not FileType.DIRECTORY:
        # Listing a file's id answers with an empty child set rather than
        # an error, so the listing that named it decides: opendir(2) says
        # ENOTDIR for `ls /data/a.txt/x`.
        raise enotdir(path_spec.virtual)
    else:
        folder_id = entry.extra["file_id"]
        drive_id = entry.extra.get("drive_id")
    drive = accessor.drive
    files = await drive.list_files(folder_id=folder_id, drive_id=drive_id)
    rows = [stat_from_item(f) for f in files]
    complete = True
    if folder_id == "root" and not target.vfs_path.strip("/"):
        # Shared Drive enumeration is best-effort: if the account can't list
        # them (missing scope, API error, network), still return My Drive
        # contents. A folder-scoped mount lists only the folder's children,
        # so shared drives never surface there.
        try:
            shared_drives = await drive.list_shared_drives()
        except (OSError, aiohttp.ClientError):
            logger.debug("Unable to list Google Shared Drives", exc_info=True)
            shared_drives = []
            complete = False
        existing_names = {row.name for row in rows}
        for d in shared_drives:
            filename = unique_shared_drive_name(d["name"], existing_names)
            existing_names.add(filename)
            rows.append(
                FileStat(
                    name=filename,
                    type=FileType.DIRECTORY,
                    extra={
                        "file_id": d["id"],
                        "mime_type": FOLDER_MIME,
                        "drive_id": d["id"],
                        "resource_type": "gdrive/shared_drive",
                    },
                )
            )
    # Deterministic vfs order: glob expansion and walkers follow readdir
    # order, so sort by rendered filename (Drive returns modifiedTime desc).
    rows.sort(key=lambda row: row.name)
    # A root whose Shared Drives could not be listed is short: kept as
    # rows, it would pin a My-Drive-only root as the whole listing until
    # it expired, hiding Shared Drives after the cause clears.
    return rows if complete else DirListing(rows, partial=True)
