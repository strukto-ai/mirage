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

import logging
import re

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.discord.entry import snowflake_to_iso
from mirage.core.discord.readdir import readdir as _readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import filetype_from_mimetype
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)

VIRTUAL_DIRS = {"", "channels", "members"}
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


async def _populate_via_parent(
    accessor: DiscordAccessor,
    virtual_key: str,
    prefix: str,
    index: IndexCacheStore,
) -> None:
    parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
    try:
        await _readdir(
            accessor,
            PathSpec(virtual=parent_virtual,
                     directory=parent_virtual,
                     resource_path=mount_key(parent_virtual, prefix)),
            index=index,
        )
    except Exception as exc:
        # best-effort cache populate; canonical ENOENT raised below
        logger.debug("stat populate failed for %s: %s", virtual_key, exc)


async def stat(
    accessor: DiscordAccessor,
    path: PathSpec,
    index: IndexCacheStore | None = None,
) -> FileStat:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path

    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)

    parts = key.split("/")
    virtual_key = prefix + "/" + key

    if len(parts) == 1:
        if index is None:
            raise enoent(virtual)
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            await _populate_via_parent(accessor, virtual_key, prefix, index)
            lookup = await index.get(virtual_key)
            if lookup.entry is None:
                raise enoent(virtual)
        return FileStat(
            name=lookup.entry.vfs_name or lookup.entry.name,
            type=FileType.DIRECTORY,
            extra={"guild_id": lookup.entry.id},
        )

    if len(parts) == 2 and parts[1] in VIRTUAL_DIRS:
        return FileStat(name=parts[1], type=FileType.DIRECTORY)

    if len(parts) == 3 and parts[1] == "channels":
        if index is None:
            raise enoent(virtual)
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            await _populate_via_parent(accessor, virtual_key, prefix, index)
            lookup = await index.get(virtual_key)
            if lookup.entry is None:
                raise enoent(virtual)
        return FileStat(
            name=lookup.entry.vfs_name or lookup.entry.name,
            type=FileType.DIRECTORY,
            modified=snowflake_to_iso(lookup.entry.remote_time),
            extra={"channel_id": lookup.entry.id},
        )

    if len(parts) == 3 and parts[1] == "members":
        if index is None:
            raise enoent(virtual)
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            await _populate_via_parent(accessor, virtual_key, prefix, index)
            lookup = await index.get(virtual_key)
            if lookup.entry is None:
                raise enoent(virtual)
        return FileStat(
            name=lookup.entry.vfs_name or lookup.entry.name,
            type=FileType.JSON,
            extra={"user_id": lookup.entry.id},
        )

    # <guild>/channels/<ch>/<date>
    if (len(parts) == 4 and parts[1] == "channels"
            and _DATE_RE.match(parts[3])):
        return FileStat(name=parts[3], type=FileType.DIRECTORY)

    # <guild>/channels/<ch>/<date>/chat.jsonl
    if (len(parts) == 5 and parts[1] == "channels" and _DATE_RE.match(parts[3])
            and parts[4] == "chat.jsonl"):
        return FileStat(name="chat.jsonl", type=FileType.TEXT)

    # <guild>/channels/<ch>/<date>/files
    if (len(parts) == 5 and parts[1] == "channels" and _DATE_RE.match(parts[3])
            and parts[4] == "files"):
        return FileStat(name="files", type=FileType.DIRECTORY)

    # <guild>/channels/<ch>/<date>/files/<blob>
    if (len(parts) == 6 and parts[1] == "channels" and _DATE_RE.match(parts[3])
            and parts[4] == "files"):
        if index is None:
            raise enoent(virtual)
        lookup = await index.get(virtual_key)
        if lookup.entry is None:
            await _populate_via_parent(accessor, virtual_key, prefix, index)
            lookup = await index.get(virtual_key)
            if lookup.entry is None:
                raise enoent(virtual)
        mimetype = (lookup.entry.extra or {}).get("content_type", "")
        return FileStat(
            name=lookup.entry.vfs_name or lookup.entry.name,
            size=lookup.entry.size,
            type=filetype_from_mimetype(mimetype),
            extra={
                "content_type": mimetype,
                "attachment_id": lookup.entry.id,
            },
        )

    raise enoent(virtual)
