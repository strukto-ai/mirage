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

from mirage.accessor.gslides import GSlidesAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.google.date_glob import glob_to_modified_range
from mirage.core.google.drive import list_all_files
from mirage.resource.gslides.slide_entry import make_filename
from mirage.types import PathSpec

MIME = "application/vnd.google-apps.presentation"


async def readdir(
    accessor: GSlidesAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    modified_range = None
    if isinstance(path, PathSpec):
        prefix = path.prefix
        if path.pattern:
            modified_range = glob_to_modified_range(path.pattern)
        path = path.directory if path.pattern else path.original
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    key = path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"

    if not key:
        return [f"{prefix}/owned", f"{prefix}/shared"]

    if key not in ("owned", "shared"):
        raise FileNotFoundError(path)

    if index is not None and not modified_range:
        cached = await index.list_dir(virtual_key)
        if cached.entries is not None:
            return cached.entries

    range_kwargs: dict[str, str] = {}
    if modified_range:
        range_kwargs["modified_after"] = modified_range[0]
        range_kwargs["modified_before"] = modified_range[1]
    files = await list_all_files(accessor.token_manager,
                                 mime_type=MIME,
                                 **range_kwargs)
    is_owned = key == "owned"
    entries = []
    for f in files:
        owners = f.get("owners", [])
        first_owner = owners[0] if owners else {}
        file_owned = first_owner.get("me", False)
        if file_owned != is_owned:
            continue
        filename = make_filename(f["name"], f["id"], f.get("modifiedTime", ""))
        entry = IndexEntry(
            id=f["id"],
            name=f["name"],
            resource_type="gslides/file",
            remote_time=f.get("modifiedTime", ""),
            vfs_name=filename,
            size=int(f.get("size") or f.get("quotaBytesUsed") or 0) or None,
        )
        entries.append((filename, entry))

    if index is not None:
        if modified_range:
            for name, entry in entries:
                await index.put(f"{virtual_key}/{name}", entry)
        else:
            await index.set_dir(virtual_key, entries)
    return [f"{prefix}/{key}/{name}" for name, _ in entries]
