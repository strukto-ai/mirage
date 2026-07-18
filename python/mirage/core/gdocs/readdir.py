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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.google.date_glob import glob_to_modified_range
from mirage.core.google.drive import GoogleFileSuffix, list_all_files
from mirage.resource.gdocs.doc_entry import make_filename
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of

MIME = "application/vnd.google-apps.document"


def is_dir_name(child: str) -> bool:
    # readdir emits only folders and rendered *.gdoc.json files.
    return not child.endswith(GoogleFileSuffix.GDOC.value)


async def readdir(
    accessor: GDocsAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    virtual = path_spec.virtual
    modified_range = None
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    if path_spec.pattern:
        modified_range = glob_to_modified_range(path_spec.pattern)
    path = path_spec.directory if path_spec.pattern else path_spec.virtual
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    key = path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"

    if not key:
        return [f"{prefix}/owned", f"{prefix}/shared"]

    if key not in ("owned", "shared"):
        raise enoent(virtual)

    if not modified_range:
        cached = await index.list_dir(virtual_key)
        if cached.entries is not None:
            return cached.entries

    files = await list_all_files(
        accessor.token_manager,
        mime_type=MIME,
        modified_after=modified_range[0] if modified_range else None,
        modified_before=modified_range[1] if modified_range else None)
    is_owned = key == "owned"
    entries = []
    for f in files:
        owners = f.get("owners", [])
        first_owner = owners[0] if owners else {}
        file_owned = first_owner.get("me", False)
        if file_owned != is_owned:
            continue
        filename = make_filename(f["name"], f["id"], f.get("modifiedTime", ""))
        source_size = int(f.get("size") or f.get("quotaBytesUsed") or 0)
        # size stays None: Drive reports the source document's storage size,
        # not the rendered JSON length (FileStat.size must be render-derived
        # or None, see the CLAUDE.md FUSE rules). The source size lives in
        # extra.
        entry = IndexEntry(
            id=f["id"],
            name=f["name"],
            resource_type="gdocs/file",
            remote_time=f.get("modifiedTime", ""),
            vfs_name=filename,
            extra={"source_size": source_size} if source_size else {},
        )
        entries.append((filename, entry))

    if modified_range:
        for name, entry in entries:
            await index.put(f"{virtual_key}/{name}", entry)
    else:
        await index.set_dir(virtual_key, entries)
    return [f"{prefix}/{key}/{name}" for name, _ in entries]
