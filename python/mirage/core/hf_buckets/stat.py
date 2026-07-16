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

from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor._hf import _HfAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type
from mirage.utils.key_prefix import mount_prefix_of


async def stat(accessor: _HfAccessor,
               path: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> FileStat:
    original_prefix = mount_prefix_of(path.virtual, path.resource_path)
    raw = path.virtual
    if original_prefix and raw.startswith(original_prefix):
        raw = raw[len(original_prefix):] or "/"
    stripped = raw.strip("/")
    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)
    virtual_key = (original_prefix + "/" +
                   stripped if original_prefix else "/" + stripped)
    lookup = await index.get(virtual_key)
    if lookup.entry is not None:
        entry = lookup.entry
        if entry.resource_type == "folder":
            return FileStat(name=entry.name, type=FileType.DIRECTORY)
        return FileStat(name=entry.name,
                        size=entry.size,
                        type=guess_type(entry.name))
    parent = virtual_key.rsplit("/", 1)[0] or "/"
    parent_listing = await index.list_dir(parent)
    if parent_listing.entries is not None:
        raise enoent(path)
    op = accessor.operator()
    key = stripped
    try:
        md = await op.stat(key)
    except NotFound:
        md = None
    if md is not None and md.mode != EntryMode.Dir:
        modified = md.last_modified.isoformat() if md.last_modified else None
        return FileStat(
            name=stripped.rsplit("/", 1)[-1],
            size=md.content_length,
            modified=modified,
            type=guess_type(raw),
            fingerprint=md.etag,
            extra={"etag": md.etag} if md.etag else {},
        )
    try:
        md_dir = await op.stat(key + "/")
        if md_dir and md_dir.mode == EntryMode.Dir:
            return FileStat(
                name=stripped.rsplit("/", 1)[-1] or "/",
                type=FileType.DIRECTORY,
            )
    except NotFound:
        # NotFound maps to the canonical ENOENT raised below
        pass
    raise enoent(path)
