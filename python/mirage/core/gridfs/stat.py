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

import re

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, ResourceType
from mirage.core.gridfs._client import _key, files_coll, latest_file
from mirage.core.timeutil import to_iso_z
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type
from mirage.utils.key_prefix import mount_prefix_of


async def stat(accessor: GridFSAccessor,
               path_spec: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> FileStat:
    virtual = path_spec.virtual
    original_prefix = mount_prefix_of(path_spec.virtual,
                                      path_spec.resource_path)
    path = path_spec.virtual
    if original_prefix and path.startswith(original_prefix):
        path = path[len(original_prefix):] or "/"

    # A trailing slash ("/gridfs/csv/") signals the caller treats it as a
    # directory. GridFS allows both a file named "csv" AND deeper files
    # under "csv/" to coexist; without this hint the file lookup would win
    # and `ls /gridfs/csv/` would list the file itself instead of the
    # prefix.
    hints_directory = path.endswith("/")

    stripped = path.strip("/")

    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)

    # Fast path: check the index cache populated by readdir().
    virtual_key = (original_prefix + "/" +
                   stripped if original_prefix else "/" + stripped)
    lookup = await index.get(virtual_key)
    if lookup.entry is not None:
        entry = lookup.entry
        # GridFS "folders" are synthetic prefixes with no file doc, so
        # readdir() records no time or size for them.
        if entry.resource_type == ResourceType.FOLDER:
            return FileStat(name=entry.name, type=FileType.DIRECTORY)
        return FileStat(
            name=entry.name,
            size=entry.size,
            modified=entry.remote_time or None,
            type=guess_type(entry.name),
        )
    # If the parent directory was already listed by readdir() but
    # this path is not among its children, it does not exist.
    # This avoids expensive network calls for paths that shells
    # probe speculatively (e.g. .git, HEAD, .hg during cd).
    parent = virtual_key.rsplit("/", 1)[0] or "/"
    parent_listing = await index.list_dir(parent)
    if parent_listing.entries is not None:
        raise enoent(virtual)

    # Slow path: no index cache available, or parent directory not yet
    # listed. Hit the database.
    config = accessor.config
    key = _key(path, config)
    # File lookup first — skipped when the path hints a directory
    # (trailing slash), so a coexisting file of the same name does not
    # shadow the prefix.
    if not hints_directory:
        doc = await latest_file(accessor, key)
        if doc is not None:
            revision = str(doc["_id"])
            upload = doc.get("uploadDate")
            return FileStat(
                name=path.rstrip("/").rsplit("/", 1)[-1],
                size=doc["length"],
                modified=to_iso_z(upload) if upload else None,
                type=guess_type(path),
                fingerprint=revision,
                revision=revision,
                extra={"file_id": revision},
            )

    # No file (or it was skipped) — check whether the path is a valid
    # prefix (directory): a "key/" marker or any deeper filename proves it.
    pfx = key.rstrip("/") + "/" if key else ""
    probe = await files_coll(accessor).find_one(
        {"filename": {
            "$regex": "^" + re.escape(pfx)
        }},
        projection={"_id": 1},
    )
    if probe is not None:
        return FileStat(
            name=path.rstrip("/").rsplit("/", 1)[-1] or "/",
            type=FileType.DIRECTORY,
        )

    raise enoent(virtual)
