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

from mirage.accessor.gcal import GCalAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.gcal.day import DATE_RE
from mirage.core.gcal.readdir import (CALENDAR_JSON, EVENT, calendar_index,
                                      normalize, readdir)
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key

logger = logging.getLogger(__name__)


async def stat(
    accessor: GCalAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Stat one node of the calendar tree.

    A well-formed day directory resolves whether or not it holds an event:
    the range query over that day is positive proof of what is there, so an
    event-free day is an empty directory rather than a miss. Only a
    malformed date, or one under a calendar that does not exist, is ENOENT.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        path (PathSpec): the path to stat.
        index (IndexCacheStore): the mount's index cache.

    Returns:
        FileStat: the node's stat row.
    """
    prefix, key, virtual_key = normalize(path)
    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)

    result = await index.get(virtual_key)
    if result.entry is None:
        parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
        try:
            await readdir(
                accessor,
                PathSpec(virtual=parent_virtual,
                         directory=parent_virtual,
                         resource_path=mount_key(parent_virtual, prefix)),
                index=index,
            )
        except FileNotFoundError as exc:
            logger.debug("gcal stat populate failed for %s: %s",
                         parent_virtual, exc)
        result = await index.get(virtual_key)

    if result.entry is None:
        parts = key.split("/")
        if len(parts) == 2 and DATE_RE.match(parts[1]):
            # Outside the default window, or a day with nothing on it. Ask
            # the calendar list rather than the index: the index only knows
            # the calendar once the ROOT has been listed, which a stat of a
            # day two levels down never triggers.
            if parts[0] not in await calendar_index(accessor):
                raise enoent(path.virtual)
            return FileStat(name=parts[1], type=FileType.DIRECTORY)
        raise enoent(path.virtual)

    entry = result.entry
    if entry.resource_type in (EVENT, CALENDAR_JSON):
        return FileStat(
            name=entry.vfs_name,
            type=FileType.JSON,
            modified=entry.remote_time,
            size=entry.size,
            extra={
                "event_id": entry.id,
                **entry.extra
            },
        )
    return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)
