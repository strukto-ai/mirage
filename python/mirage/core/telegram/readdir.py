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

from datetime import datetime, timezone

from mirage.accessor.telegram import TelegramAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.telegram.chats import (chat_category, chat_display_name,
                                        discover_chats)
from mirage.types import PathSpec

VIRTUAL_ROOTS = ("groups", "channels", "private")


def _safe_name(name: str) -> str:
    if not name:
        return "unknown"
    return name.replace("/", "\u2215")


def _chat_dirname(chat: dict) -> str:
    name = _safe_name(chat_display_name(chat))
    return f"{name}__{chat['id']}"


async def readdir(
    accessor: TelegramAccessor,
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

    if not key:
        return [f"{prefix}/{d}" for d in VIRTUAL_ROOTS]

    parts = key.split("/")

    if len(parts) == 1 and parts[0] in VIRTUAL_ROOTS:
        category = parts[0]
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
        chats = await discover_chats(accessor.config)
        filtered = [c for c in chats if chat_category(c) == category]
        entries = []
        names = []
        for c in filtered:
            dirname = _chat_dirname(c)
            entry = IndexEntry(
                id=str(c["id"]),
                name=chat_display_name(c),
                resource_type=f"telegram/{category}",
                vfs_name=dirname,
            )
            entries.append((dirname, entry))
            names.append(f"{prefix}/{key}/{dirname}")
        if index is not None:
            await index.set_dir(virtual_key, entries)
        return names

    if len(parts) == 2 and parts[0] in VIRTUAL_ROOTS:
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
        today = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
        filename = f"{today}.jsonl"
        entry = IndexEntry(
            id=f"{key}:{today}",
            name=today,
            resource_type="telegram/history",
            vfs_name=filename,
        )
        if index is not None:
            await index.set_dir(virtual_key, [(filename, entry)])
        return [f"{prefix}/{key}/{filename}"]

    return []
