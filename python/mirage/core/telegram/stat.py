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

from mirage.accessor.telegram import TelegramAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.telegram.readdir import readdir as _readdir
from mirage.core.telegram.scope import CATEGORIES
from mirage.types import FileStat, FileType, PathSpec

VIRTUAL_DIRS = {"", "groups", "channels", "private"}


async def stat(
    accessor: TelegramAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original

    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    key = path.strip("/")

    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)

    parts = key.split("/")
    virtual_key = prefix + "/" + key

    if len(parts) == 1 and parts[0] in VIRTUAL_DIRS:
        return FileStat(name=parts[0], type=FileType.DIRECTORY)

    if len(parts) == 2 and parts[0] in CATEGORIES:
        if index is None:
            raise FileNotFoundError(path)
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
            try:
                await _readdir(
                    accessor,
                    PathSpec(original=parent_virtual,
                             directory=parent_virtual,
                             prefix=prefix),
                    index=index,
                )
            # best-effort cache populate; canonical ENOENT raised below
            except Exception:
                pass
            lookup = await index.get(virtual_key)
            if lookup.entry is None:
                raise FileNotFoundError(path)
        return FileStat(
            name=lookup.entry.vfs_name or lookup.entry.name,
            type=FileType.DIRECTORY,
            extra={"chat_id": lookup.entry.id},
        )

    if (len(parts) == 3 and parts[0] in CATEGORIES
            and parts[2].endswith(".jsonl")):
        return FileStat(name=parts[2], type=FileType.TEXT)

    raise FileNotFoundError(path)
