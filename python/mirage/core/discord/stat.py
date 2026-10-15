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

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.scope import detect_scope
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.time_range import day_stat, guard_day
from mirage.errors.fs import enoent
from mirage.types import ContentType, FileStat, FileType, PathSpec


async def _stat_chat(
    accessor: DiscordAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> FileStat:
    """Stat chat.jsonl, which survives a sealed day.

    A day whose history could not be listed (403/404/429) seals an
    empty date dir; the file still stats, with the size left unknown.

    Args:
        accessor (DiscordAccessor): discord accessor.
        match (ScopeMatch): a match holding the day chain.
        path (PathSpec): the path to stat.
        entry (FileStat | None): the file's row, when its day lists it.
        parent (FileStat | None): the day's row.
    """
    await guard_day(accessor, match, path.virtual)
    if entry is not None:
        return entry
    if parent is None:
        raise enoent(path.virtual)
    return FileStat(
        name="chat.jsonl",
        type=FileType.FILE,
        content=ContentType.TEXT,
        size=None,
    )


# A files directory or a blob is what its day's listing names, which no
# day outside the mount's scope has; a day and its chat.jsonl exist
# beyond what is listed.
stat = make_stat(
    detect_scope,
    overrides={
        "day": day_stat(guard_day),
        "messages": _stat_chat,
    },
)
