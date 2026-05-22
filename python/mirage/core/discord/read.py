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

import json

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.discord.files import download_file
from mirage.core.discord.history import get_history_jsonl
from mirage.core.discord.members import list_members
from mirage.core.discord.readdir import readdir as _readdir
from mirage.types import PathSpec


async def _ensure_channel(
    index: IndexCacheStore,
    prefix: str,
    ch_key: str,
    raw: str,
):
    ch_virtual = prefix + "/" + ch_key
    lookup = await index.get(ch_virtual)
    if lookup.entry is None:
        raise FileNotFoundError(raw)
    return lookup


async def read(
    accessor: DiscordAccessor,
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

    # <guild>/channels/<ch>/<date>/chat.jsonl
    if (len(parts) == 5 and parts[1] == "channels"
            and parts[4] == "chat.jsonl"):
        if index is None:
            raise FileNotFoundError(key)
        ch_key = f"{parts[0]}/{parts[1]}/{parts[2]}"
        ch_lookup = await _ensure_channel(index, prefix, ch_key, key)
        return await get_history_jsonl(accessor.config, ch_lookup.entry.id,
                                       parts[3])

    # <guild>/channels/<ch>/<date>/files/<blob>
    if (len(parts) == 6 and parts[1] == "channels" and parts[4] == "files"):
        if index is None:
            raise FileNotFoundError(key)
        virtual_key = prefix + "/" + key
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            # Hydrate via date dir readdir, which triggers _fetch_day
            date_key = "/".join(parts[:4])
            date_spec = PathSpec(
                original=prefix + "/" + date_key,
                directory=prefix + "/" + date_key,
                prefix=prefix,
            )
            await _readdir(accessor, date_spec, index)
            lookup = await index.get(virtual_key)
        if lookup.entry is None:
            raise FileNotFoundError(key)
        url = (lookup.entry.extra
               or {}).get("url") or (lookup.entry.extra
                                     or {}).get("proxy_url") or ""
        if not url:
            raise FileNotFoundError(key)
        return await download_file(url)

    # <guild>/members/<user>.json
    if len(parts) == 3 and parts[1] == "members":
        if index is None:
            raise FileNotFoundError(key)
        virtual_key = prefix + "/" + key
        entry_lookup = await index.get(virtual_key)
        if entry_lookup.entry is None:
            raise FileNotFoundError(key)
        guild_virtual = prefix + "/" + parts[0]
        guild_lookup = await index.get(guild_virtual)
        if guild_lookup.entry is None:
            raise FileNotFoundError(key)
        members = await list_members(accessor.config, guild_lookup.entry.id)
        for m in members:
            user = m.get("user", {})
            if user.get("id") == entry_lookup.entry.id:
                return json.dumps(m, ensure_ascii=False).encode()
        raise FileNotFoundError(key)

    raise FileNotFoundError(key)
