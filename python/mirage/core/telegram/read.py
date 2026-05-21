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
from mirage.core.telegram.history import get_updates_for_chat
from mirage.core.telegram.scope import CATEGORIES
from mirage.types import PathSpec


async def read(
    accessor: TelegramAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> bytes:
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
    parts = key.split("/")

    if (len(parts) == 3 and parts[0] in CATEGORIES
            and parts[2].endswith(".jsonl")):
        chat_key = f"{parts[0]}/{parts[1]}"
        if index is None:
            raise FileNotFoundError(key)
        virtual = prefix + "/" + chat_key
        lookup = await index.get(virtual)
        if lookup.entry is None:
            raise FileNotFoundError(key)
        date_str = parts[2].removesuffix(".jsonl")
        return await get_updates_for_chat(accessor.config, lookup.entry.id,
                                          date_str)

    raise FileNotFoundError(key)
