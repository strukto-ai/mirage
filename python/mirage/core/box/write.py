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

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import native_condition, write_condition
from mirage.core.box.api import refused, upload_file_version, upload_new_file
from mirage.core.box.client import BoxApiError
from mirage.core.box.constants import CONFLICT_STATUS
from mirage.core.box.fingerprint import live_of
from mirage.core.box.readdir import stat_from_item
from mirage.core.box.resolve import (
    item_of,
    live_item,
    live_item_of,
    parent_folder,
    path_parts,
)
from mirage.errors.fs import eisdir
from mirage.observe.context import record, start_op
from mirage.types import FileStat, FileType, JsonValue, PathSpec
from mirage.utils.upload import upload_stat


async def _upload_new(
    accessor: BoxAccessor, path: PathSpec, data: bytes, folder_id: str
) -> JsonValue:
    """Upload ``data`` as a new file at ``path``, plainly.

    The listing named nothing there; Box holding a file by that name now
    means the listing is older than it, so the file found live gets a new
    version, as a write to a listed file would.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): target path.
        data (bytes): file content.
        folder_id (str): the folder the file lands in.
    """
    tm = accessor.token_manager
    try:
        return await upload_new_file(tm, folder_id, path_parts(path)[-1], data)
    except BoxApiError as exc:
        if exc.status != CONFLICT_STATUS or exc.conflict not in (None, "file"):
            raise
        found = await live_item(accessor, path, None)
        if found is None or found.get("type") != "file":
            raise
        return await upload_file_version(
            tm, found["id"], found["name"], data, None
        )


async def write(
    accessor: BoxAccessor,
    path: PathSpec,
    data: bytes,
    entry: FileStat | None = None,
    parent: FileStat | None = None,
) -> FileStat | None:
    """Upload a new file, or a new version of an existing one.

    A held version goes out as the file's etag.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): target path.
        data (bytes): file content.
        entry (FileStat | None): what is at the path.
        parent (FileStat | None): what is at its parent path.

    Returns:
        FileStat | None: the stored file's stat, None for a reply that
            names none.
    """
    parts = path_parts(path)
    if not parts or (entry is not None and entry.type is FileType.DIRECTORY):
        raise eisdir(path.virtual)
    tm = accessor.token_manager
    cond = await write_condition(path, "put")
    timer = start_op()
    # What is there now: the listed row can be older than the path's file,
    # and older than the read a held version came from.
    existing = (
        await live_item(accessor, path, item_of(entry))
        if cond is not None
        else await live_item_of(accessor, path, entry)
    )
    etag = await native_condition(path, cond, live_of(existing), "put")
    try:
        if existing is not None and existing.get("type") == "file":
            # Overwrite uploads a new version under the same id, keeping
            # Box's own name so a box-native file isn't renamed with the
            # vfs suffix.
            reply = await upload_file_version(
                tm, existing["id"], existing["name"], data, etag
            )
        elif cond is None:
            reply = await _upload_new(
                accessor, path, data, parent_folder(accessor, path, parent)
            )
        else:
            reply = await upload_new_file(
                tm, parent_folder(accessor, path, parent), parts[-1], data
            )
    except BoxApiError as exc:
        raise (await refused(path, exc, cond, etag)) or exc
    entries = reply.get("entries") if isinstance(reply, dict) else None
    item = entries[0] if isinstance(entries, list) and entries else None
    stored = upload_stat(item, stat_from_item, path.virtual)
    token = None if stored is None else stored.fingerprint
    record("write", path.virtual, "box", len(data), timer, fingerprint=token)
    return stored
