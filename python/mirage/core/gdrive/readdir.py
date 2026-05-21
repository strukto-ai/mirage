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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.google.drive import MIME_TO_EXT, list_files
from mirage.types import PathSpec


async def readdir(
    accessor: GDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.directory if path.pattern else path.original
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    key = path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"

    if index is not None:
        cached = await index.list_dir(virtual_key)
        if cached.entries is not None:
            return cached.entries

    if not key:
        folder_id = "root"
    else:
        if index is None:
            raise FileNotFoundError(path)
        result = await index.get(virtual_key)
        if result.entry is None:
            parent_virtual = virtual_key.rstrip("/").rsplit("/", 1)[0] or "/"
            if parent_virtual != virtual_key:
                parent_path = PathSpec.from_str_path(parent_virtual,
                                                     prefix=prefix)
                await readdir(accessor, parent_path, index)
                result = await index.get(virtual_key)
            if result.entry is None:
                raise FileNotFoundError(path)
        folder_id = result.entry.id

    files = await list_files(accessor.token_manager, folder_id=folder_id)
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
        owners = f.get("owners", [])
        owners[0] if owners else {}
        entry = IndexEntry(
            id=f["id"],
            name=name,
            resource_type=rt,
            remote_time=f.get("modifiedTime", ""),
            vfs_name=filename,
            size=int(f.get("size") or f.get("quotaBytesUsed") or 0) or None,
        )
        entries.append((filename, entry, is_dir))

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
