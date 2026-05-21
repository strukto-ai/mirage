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

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.notion.pages import list_block_children, search_pages
from mirage.core.notion.pathing import page_dirname, split_suffix_id
from mirage.types import PathSpec
from mirage.utils.sanitize import sanitize_name

VIRTUAL_ROOTS = ("pages", )


async def readdir(
    accessor: NotionAccessor,
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
    idx_key = "/" + key if key else "/"

    if not key:
        return [f"{prefix}/pages"]

    if key == "pages":
        if index is not None:
            listing = await index.list_dir(idx_key)
            if listing.entries is not None:
                return listing.entries
        pages = await search_pages(accessor.config)
        top_level = [
            p for p in pages if p.get("parent", {}).get("type") == "workspace"
        ]
        entries = []
        for page in top_level:
            dirname = page_dirname(page)
            entry = IndexEntry(
                id=page["id"],
                name=dirname,
                resource_type="notion/page",
                remote_time=page.get("last_edited_time", ""),
                vfs_name=dirname,
            )
            entries.append((dirname, entry))
        if index is not None:
            await index.set_dir(idx_key, entries)
        return [f"{prefix}/pages/{name}" for name, _ in entries]

    parts = key.split("/")
    if len(parts) >= 2 and parts[0] == "pages":
        _, page_id = split_suffix_id(parts[-1])
        page_idx_key = "/" + "/".join(parts)

        if index is not None:
            listing = await index.list_dir(page_idx_key)
            if listing.entries is not None:
                return listing.entries

        blocks = await list_block_children(accessor.config, page_id)
        child_pages = [b for b in blocks if b.get("type") == "child_page"]
        entries: list[tuple[str, IndexEntry]] = []

        page_json_entry = IndexEntry(
            id=f"{page_id}:page",
            name="page.json",
            resource_type="file",
            vfs_name="page.json",
        )
        entries.append(("page.json", page_json_entry))

        for child_block in child_pages:
            child_title = child_block.get("child_page",
                                          {}).get("title", "untitled")
            child_id = child_block["id"]
            dirname = f"{sanitize_name(child_title)}__{child_id}"
            child_entry = IndexEntry(
                id=child_id,
                name=dirname,
                resource_type="notion/page",
                vfs_name=dirname,
            )
            entries.append((dirname, child_entry))

        if index is not None:
            await index.set_dir(page_idx_key, entries)

        base = f"{prefix}/{key}"
        return [f"{base}/{name}" for name, _ in entries]

    return []
