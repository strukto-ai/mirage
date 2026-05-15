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

from datetime import datetime, timedelta, timezone

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.slack._client import slack_get
from mirage.core.slack.channels import list_channels, list_dms
from mirage.core.slack.files import file_blob_name
from mirage.core.slack.formatters import (channel_dirname, dm_dirname,
                                          user_filename)
from mirage.core.slack.history import fetch_messages_for_day
from mirage.core.slack.scope import SlackScope, detect_scope
from mirage.core.slack.users import list_users
from mirage.types import PathSpec

VIRTUAL_ROOTS = ("channels", "dms", "users")


def _date_range(latest_ts: float,
                created: int,
                max_days: int = 90) -> list[str]:
    end = datetime.fromtimestamp(latest_ts, tz=timezone.utc).date()
    start = datetime.fromtimestamp(created, tz=timezone.utc).date()
    if (end - start).days > max_days:
        start = end - timedelta(days=max_days - 1)
    dates = []
    d = end
    while d >= start:
        dates.append(d.isoformat())
        d -= timedelta(days=1)
    return dates


async def _latest_message_ts(config, channel_id: str) -> float | None:
    data = await slack_get(config,
                           "conversations.history",
                           params={
                               "channel": channel_id,
                               "limit": 1,
                           })
    messages = data.get("messages", [])
    if messages:
        return float(messages[0].get("ts", "0"))
    return None


def _normalize_path(path: PathSpec | str) -> tuple[PathSpec, str, str, str]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    prefix = path.prefix or ""
    raw = path.directory if path.pattern else path.original
    if prefix and raw.startswith(prefix):
        raw = raw[len(prefix):] or "/"
    key = raw.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"
    return path, prefix, key, virtual_key


async def _readdir_root(prefix: str) -> list[str]:
    return [f"{prefix}/channels", f"{prefix}/dms", f"{prefix}/users"]


async def _readdir_channels(
    accessor: SlackAccessor,
    prefix: str,
    virtual_key: str,
    index: IndexCacheStore | None,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    channels = await list_channels(accessor.config)
    entries: list[tuple[str, IndexEntry]] = []
    names: list[str] = []
    for ch in channels:
        dirname = channel_dirname(ch)
        entry = IndexEntry(
            id=ch["id"],
            name=ch.get("name", ""),
            resource_type="slack/channel",
            vfs_name=dirname,
            remote_time=str(ch.get("created", 0)),
        )
        entries.append((dirname, entry))
        names.append(f"{prefix}/channels/{dirname}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _readdir_dms(
    accessor: SlackAccessor,
    prefix: str,
    virtual_key: str,
    index: IndexCacheStore | None,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    dms = await list_dms(accessor.config)
    users = await list_users(accessor.config)
    user_map = {u["id"]: u.get("name", u["id"]) for u in users}
    entries: list[tuple[str, IndexEntry]] = []
    names: list[str] = []
    for dm in dms:
        dirname = dm_dirname(dm, user_map)
        uid = dm.get("user", "")
        entry = IndexEntry(
            id=dm["id"],
            name=user_map.get(uid, uid),
            resource_type="slack/dm",
            vfs_name=dirname,
            remote_time=str(dm.get("created", 0)),
        )
        entries.append((dirname, entry))
        names.append(f"{prefix}/dms/{dirname}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _readdir_users(
    accessor: SlackAccessor,
    prefix: str,
    virtual_key: str,
    index: IndexCacheStore | None,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    users = await list_users(accessor.config)
    entries: list[tuple[str, IndexEntry]] = []
    names: list[str] = []
    for u in users:
        filename = user_filename(u)
        entry = IndexEntry(
            id=u["id"],
            name=u.get("name", ""),
            resource_type="slack/user",
            vfs_name=filename,
        )
        entries.append((filename, entry))
        names.append(f"{prefix}/users/{filename}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _readdir_channel_dates(
    accessor: SlackAccessor,
    path: PathSpec,
    prefix: str,
    key: str,
    virtual_key: str,
    container: str,
    index: IndexCacheStore | None,
) -> list[str]:
    if index is None:
        raise FileNotFoundError(path)
    lookup = await index.get(virtual_key)
    if lookup.entry is None:
        parent_str = prefix + "/" + container
        parent = PathSpec(original=parent_str,
                          directory=parent_str,
                          prefix=prefix)
        await readdir(accessor, parent, index)
        lookup = await index.get(virtual_key)
    if lookup.entry is None:
        raise FileNotFoundError(path)
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    created = int(lookup.entry.remote_time or 0)
    latest_ts = await _latest_message_ts(accessor.config, lookup.entry.id)
    if latest_ts and created:
        dates = _date_range(latest_ts, created)
    elif latest_ts:
        dates = _date_range(latest_ts, int(latest_ts))
    else:
        dates = []
    entries: list[tuple[str, IndexEntry]] = []
    names: list[str] = []
    for d in dates:
        entry = IndexEntry(
            id=f"{lookup.entry.id}:{d}",
            name=d,
            resource_type="slack/date_dir",
            vfs_name=d,
        )
        entries.append((d, entry))
        names.append(f"{prefix}/{key}/{d}")
    await index.set_dir(virtual_key, entries)
    return names


async def _readdir_date_contents(
    accessor: SlackAccessor,
    path: PathSpec,
    prefix: str,
    key: str,
    virtual_key: str,
    container: str,
    chan_seg: str,
    date_str: str,
    index: IndexCacheStore | None,
) -> list[str]:
    if index is None:
        raise FileNotFoundError(path)
    cached = await index.list_dir(virtual_key)
    if cached.entries is not None:
        return cached.entries
    parent_vk = f"{prefix}/{container}/{chan_seg}"
    parent_lookup = await index.get(parent_vk)
    if parent_lookup.entry is None:
        parent_str = f"{prefix}/{container}/{chan_seg}"
        parent = PathSpec(original=parent_str,
                          directory=parent_str,
                          prefix=prefix)
        await readdir(accessor, parent, index)
        parent_lookup = await index.get(parent_vk)
    if parent_lookup.entry is None:
        raise FileNotFoundError(path)
    channel_id = parent_lookup.entry.id
    await _fetch_day(accessor, channel_id, date_str, virtual_key, index)
    cached = await index.list_dir(virtual_key)
    if cached.entries is not None:
        return cached.entries
    raise FileNotFoundError(path)


async def _readdir_files_dir(
    accessor: SlackAccessor,
    path: PathSpec,
    prefix: str,
    key: str,
    virtual_key: str,
    container: str,
    chan_seg: str,
    date_str: str,
    index: IndexCacheStore | None,
) -> list[str]:
    if index is None:
        raise FileNotFoundError(path)
    cached = await index.list_dir(virtual_key)
    if cached.entries is not None:
        return cached.entries
    date_str_path = f"{prefix}/{container}/{chan_seg}/{date_str}"
    date_path = PathSpec(original=date_str_path,
                         directory=date_str_path,
                         prefix=prefix)
    await readdir(accessor, date_path, index)
    cached = await index.list_dir(virtual_key)
    if cached.entries is not None:
        return cached.entries
    raise FileNotFoundError(path)


async def readdir(
    accessor: SlackAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> list[str]:
    path, prefix, key, virtual_key = _normalize_path(path)

    if not key:
        return await _readdir_root(prefix)

    scope = detect_scope(path)
    container = scope.container

    if key == "channels":
        return await _readdir_channels(accessor, prefix, virtual_key, index)
    if key == "dms":
        return await _readdir_dms(accessor, prefix, virtual_key, index)
    if key == "users":
        return await _readdir_users(accessor, prefix, virtual_key, index)

    parts = key.split("/")
    if container in ("channels", "dms") and len(parts) == 2:
        return await _readdir_channel_dates(accessor, path, prefix, key,
                                            virtual_key, container, index)
    if container in ("channels", "dms") and scope.target == "date":
        return await _readdir_date_contents(accessor, path, prefix, key,
                                            virtual_key, container, parts[1],
                                            parts[2], index)
    if container in ("channels", "dms") and scope.target == "files":
        return await _readdir_files_dir(accessor, path, prefix, key,
                                        virtual_key, container, parts[1],
                                        parts[2], index)
    return []


async def _fetch_day(
    accessor: SlackAccessor,
    channel_id: str,
    date_str: str,
    date_vkey: str,
    index: IndexCacheStore,
) -> None:
    messages = await fetch_messages_for_day(accessor.config, channel_id,
                                            date_str)
    chat_entry = IndexEntry(
        id=f"{channel_id}:{date_str}:chat",
        name="chat.jsonl",
        resource_type="slack/chat_jsonl",
        vfs_name="chat.jsonl",
    )
    files_entry = IndexEntry(
        id=f"{channel_id}:{date_str}:files",
        name="files",
        resource_type="slack/files_dir",
        vfs_name="files",
    )
    await index.set_dir(date_vkey, [
        ("chat.jsonl", chat_entry),
        ("files", files_entry),
    ])
    file_entries: list[tuple[str, IndexEntry]] = []
    for msg in messages:
        for fmeta in msg.get("files", []) or []:
            if not fmeta.get("id"):
                continue
            blob_name = file_blob_name(fmeta)
            file_entries.append(
                (blob_name,
                 IndexEntry(
                     id=fmeta["id"],
                     name=fmeta.get("title") or fmeta.get("name") or "",
                     resource_type="slack/file",
                     vfs_name=blob_name,
                     size=fmeta.get("size"),
                     remote_time=str(fmeta.get("timestamp", "")),
                     extra={
                         "mimetype":
                         fmeta.get("mimetype", ""),
                         "url_private_download":
                         fmeta.get("url_private_download", ""),
                         "filetype":
                         fmeta.get("filetype", ""),
                         "ts":
                         msg.get("ts", ""),
                         "channel_id":
                         channel_id,
                         "date":
                         date_str,
                     },
                 )))
    await index.set_dir(date_vkey + "/files", file_entries)


__all__ = ["readdir", "VIRTUAL_ROOTS", "SlackScope"]
