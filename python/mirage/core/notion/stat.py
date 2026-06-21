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
from mirage.cache.index import IndexCacheStore
from mirage.core.notion.pathing import split_suffix_id
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type


async def stat(
    accessor: NotionAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    virtual = path.original
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"

    key = path.strip("/")

    if not key or key == "pages":
        return FileStat(name=key or "/", type=FileType.DIRECTORY)

    parts = key.split("/")

    if parts[-1] == "page.json":
        return FileStat(name="page.json", type=guess_type("page.json"))

    if len(parts) >= 2 and parts[0] == "pages":
        _, page_id = split_suffix_id(parts[-1])
        if index is not None:
            idx_key = "/" + key
            result = await index.get(idx_key)
            if result.entry is not None:
                return FileStat(
                    name=result.entry.name,
                    type=FileType.DIRECTORY,
                    modified=result.entry.remote_time or None,
                    extra={"page_id": page_id},
                )
        return FileStat(
            name=parts[-1],
            type=FileType.DIRECTORY,
            extra={"page_id": page_id},
        )

    raise enoent(virtual)
