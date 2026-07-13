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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.google.drive import (MIME_TO_EXT, list_files,
                                      list_shared_drives)
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


def is_dir_name(child: str) -> bool | None:
    # Cold listings mark folders with a trailing slash; warm index-cache
    # entries are slash-less, so classification falls back to stat.
    return True if child.endswith("/") else None


def unique_shared_drive_name(name: str, existing_names: set[str]) -> str:
    if name not in existing_names:
        return name
    filename = f"{name} [Shared Drive]"
    suffix = 2
    while filename in existing_names:
        filename = f"{name} [Shared Drive {suffix}]"
        suffix += 1
    return filename


async def readdir(
    accessor: GDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    path = (path.dir if path.pattern else path).mount_path
    key = path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"

    if index is not None:
        cached = await index.list_dir(virtual_key)
        # Cached entries are slash-less, while the cold path below marks
        # folders with a trailing slash. Callers must not infer dir-ness
        # from the slash alone (see find's stat fallback).
        if cached.entries is not None:
            return cached.entries

    if not key:
        folder_id = "root"
        drive_id = None
    else:
        if index is None:
            raise enoent(virtual)
        result = await index.get(virtual_key)
        if result.entry is None:
            parent_virtual = virtual_key.rstrip("/").rsplit("/", 1)[0] or "/"
            if parent_virtual != virtual_key:
                parent_path = PathSpec.from_str_path(
                    parent_virtual, mount_key(parent_virtual, prefix))
                await readdir(accessor, parent_path, index)
                result = await index.get(virtual_key)
            if result.entry is None:
                raise enoent(virtual)
        folder_id = result.entry.id
        drive_id = result.entry.extra.get("drive_id")

    files = await list_files(accessor.token_manager,
                             folder_id=folder_id,
                             drive_id=drive_id)
    entries = []
    for f in files:
        mime = f.get("mimeType", "")
        name = f["name"]
        ext = MIME_TO_EXT.get(mime)
        if ext:
            filename = f"{name}{ext}"
        else:
            filename = name
        is_dir = mime == "application/vnd.google-apps.folder"
        if is_dir:
            rt = "gdrive/folder"
        elif mime == "application/vnd.google-apps.document":
            rt = "gdrive/gdoc"
        elif mime == "application/vnd.google-apps.spreadsheet":
            rt = "gdrive/gsheet"
        elif mime == "application/vnd.google-apps.presentation":
            rt = "gdrive/gslide"
        else:
            rt = "gdrive/file"
        source_size = int(f.get("size") or f.get("quotaBytesUsed") or 0)
        extra = {"drive_id": f.get("driveId")} if f.get("driveId") else {}
        # Binary files download raw, so Drive's size is the rendered byte
        # length and stays. Google-apps files (gdoc/gsheet/gslide) render to
        # JSON, so Drive's source size must not become FileStat.size
        # (render-derived or None, see the CLAUDE.md FUSE rules); it lives in
        # extra instead.
        if rt == "gdrive/file":
            size = source_size or None
        else:
            size = None
            if source_size:
                extra["source_size"] = source_size
        entry = IndexEntry(
            id=f["id"],
            name=name,
            resource_type=rt,
            remote_time=f.get("modifiedTime", ""),
            vfs_name=filename,
            size=size,
            extra=extra,
        )
        entries.append((filename, entry, is_dir))

    if not key:
        # Shared Drive enumeration is best-effort: if the account can't list
        # them (missing scope, API error), still return My Drive contents.
        try:
            shared_drives = await list_shared_drives(accessor.token_manager)
        except Exception:
            logger.debug("Unable to list Google Shared Drives", exc_info=True)
            shared_drives = []
        existing_names = {name for name, _, _ in entries}
        for d in shared_drives:
            name = d["name"]
            filename = unique_shared_drive_name(name, existing_names)
            existing_names.add(filename)
            entry = IndexEntry(
                id=d["id"],
                name=name,
                resource_type="gdrive/shared_drive",
                vfs_name=filename,
                extra={"drive_id": d["id"]},
            )
            entries.append((filename, entry, True))

    if index is not None:
        await index.set_dir(virtual_key, [(name, e) for name, e, _ in entries])
    path_prefix = f"/{key}/" if key else "/"
    result_paths = []
    for name, _, is_folder in entries:
        if is_folder:
            result_paths.append(f"{prefix}{path_prefix}{name}/")
        else:
            result_paths.append(f"{prefix}{path_prefix}{name}")
    return result_paths
