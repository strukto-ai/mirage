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

from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.slack.readdir import readdir
from mirage.core.slack.scope import detect_scope
from mirage.core.time_range import day_stat, guard_day
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.dates import epoch_to_iso
from mirage.utils.filetype import content_type_for_mime


def _slack_modified(remote_time: str) -> str | None:
    if not remote_time:
        return None
    try:
        ts = float(remote_time)
    except (TypeError, ValueError):
        return None
    if ts <= 0:
        return None
    return epoch_to_iso(ts)


def _channel_stat(
    match: ScopeMatch, path: PathSpec, entry: IndexEntry
) -> FileStat:
    return FileStat(
        name=entry.vfs_name or entry.name,
        type=FileType.DIRECTORY,
        modified=_slack_modified(entry.remote_time),
        extra={"channel_id": entry.id},
    )


def _user_stat(
    match: ScopeMatch, path: PathSpec, entry: IndexEntry
) -> FileStat:
    return FileStat(
        name=entry.vfs_name or entry.name,
        type=FileType.FILE,
        content=ContentType.JSON,
        size=entry.size,
        extra={"user_id": entry.id},
    )


def _dir_stat(
    match: ScopeMatch, path: PathSpec, entry: IndexEntry
) -> FileStat:
    return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)


def _file_blob_stat(
    match: ScopeMatch, path: PathSpec, entry: IndexEntry
) -> FileStat:
    mimetype = entry.extra.get("mimetype", "")
    return FileStat(
        name=entry.vfs_name or entry.name,
        type=FileType.FILE,
        content=content_type_for_mime(mimetype),
        size=entry.size,
        modified=_slack_modified(entry.remote_time),
        extra={"file_id": entry.id},
    )


def _chat_stat(
    match: ScopeMatch, path: PathSpec, entry: IndexEntry
) -> FileStat:
    # A denied or empty day lists no chat.jsonl, and the kit reports the
    # absent entry as ENOENT: slack does not fabricate a sizeless file
    # for a sealed day (discord deliberately does; see its override).
    return FileStat(
        name="chat.jsonl",
        type=FileType.FILE,
        content=ContentType.TEXT,
        size=entry.size,
    )


stat = make_stat(
    detect_scope,
    readdir,
    guards={kind: guard_day for kind in ("messages", "files", "file_blob")},
    entry_stats={
        "channel": _channel_stat,
        "user": _user_stat,
        "messages": _chat_stat,
        "files": _dir_stat,
        "file_blob": _file_blob_stat,
    },
    overrides={"day": day_stat(readdir, guard_day)},
)
