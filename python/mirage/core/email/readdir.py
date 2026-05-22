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

import re
from email.utils import parsedate_to_datetime

from mirage.accessor.email import EmailAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.email._client import fetch_headers, list_message_uids
from mirage.core.email.folders import list_folders
from mirage.types import PathSpec

TITLE_MAX = 80
UNSAFE = re.compile(r"[^\w\s\-.]")
MULTI_UNDERSCORE = re.compile(r"_+")


def _sanitize(text: str) -> str:
    if not text.strip():
        return "No_Subject"
    cleaned = UNSAFE.sub("_", text).replace(" ", "_")
    cleaned = MULTI_UNDERSCORE.sub("_", cleaned).strip("_")
    if len(cleaned) > TITLE_MAX:
        cleaned = cleaned[:TITLE_MAX - 3] + "..."
    return cleaned


def _msg_filename(subject: str, uid: str) -> str:
    return f"{_sanitize(subject)}__{uid}.email.json"


def _date_from_header(date_str: str) -> str:
    try:
        dt = parsedate_to_datetime(date_str)
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return "1970-01-01"


async def readdir(
    accessor: EmailAccessor,
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
    parts = key.split("/") if key else []
    depth = len(parts)

    if depth == 0:
        if index is not None:
            cached = await index.list_dir(virtual_key)
            if cached.entries is not None:
                return cached.entries
        folders = await list_folders(accessor)
        entries = []
        for folder_name in folders:
            entry = IndexEntry(
                id=folder_name,
                name=folder_name,
                resource_type="email/folder",
                vfs_name=folder_name,
            )
            entries.append((folder_name, entry))
        if index is not None:
            await index.set_dir(virtual_key, entries)
        return [f"{prefix}/{name}" for name, _ in entries]

    if depth == 1:
        folder_name = parts[0]
        if index is not None:
            cached = await index.list_dir(virtual_key)
            if cached.entries is not None:
                return cached.entries
        if index is None:
            raise FileNotFoundError(path)
        max_msgs = accessor.config.max_messages
        uids = await list_message_uids(accessor,
                                       folder_name,
                                       max_results=max_msgs)
        headers_list = await fetch_headers(accessor, folder_name, uids)
        date_groups: dict[str, list[dict]] = {}
        for hdr in headers_list:
            date_str = _date_from_header(hdr.get("date", ""))
            date_groups.setdefault(date_str, []).append(hdr)
        date_entries: list[tuple[str, IndexEntry]] = []
        for date_str in sorted(date_groups.keys(), reverse=True):
            date_entry = IndexEntry(
                id=date_str,
                name=date_str,
                resource_type="email/date",
                vfs_name=date_str,
            )
            date_entries.append((date_str, date_entry))
            msg_entries: list[tuple[str, IndexEntry]] = []
            for hdr in date_groups[date_str]:
                uid = hdr["uid"]
                subject = hdr.get("subject", "") or "No Subject"
                filename = _msg_filename(subject, uid)
                msg_entry = IndexEntry(
                    id=uid,
                    name=subject,
                    resource_type="email/message",
                    vfs_name=filename,
                )
                msg_entries.append((filename, msg_entry))
                attachments = hdr.get("attachments", [])
                if attachments:
                    att_dir_name = filename.replace(".email.json", "")
                    att_dir_entry = IndexEntry(
                        id=uid,
                        name=att_dir_name,
                        resource_type="email/attachment_dir",
                        vfs_name=att_dir_name,
                    )
                    msg_entries.append((att_dir_name, att_dir_entry))
                    att_entries: list[tuple[str, IndexEntry]] = []
                    for att in attachments:
                        att_entry = IndexEntry(
                            id=att["filename"],
                            name=att["filename"],
                            resource_type="email/attachment",
                            vfs_name=att["filename"],
                            size=att.get("size"),
                        )
                        att_entries.append((att["filename"], att_entry))
                    att_dir_vkey = (virtual_key + "/" + date_str + "/" +
                                    att_dir_name)
                    await index.set_dir(att_dir_vkey, att_entries)
            date_vkey = virtual_key + "/" + date_str
            await index.set_dir(date_vkey, msg_entries)
        await index.set_dir(virtual_key, date_entries)
        return [f"{prefix}/{key}/{name}" for name, _ in date_entries]

    if depth == 2:
        if index is None:
            raise FileNotFoundError(path)
        cached = await index.list_dir(virtual_key)
        if cached.entries is not None:
            return cached.entries
        folder_vkey = PathSpec(
            original=prefix + "/" + parts[0],
            directory=prefix + "/" + parts[0],
            prefix=prefix,
        )
        await readdir(accessor, folder_vkey, index)
        cached = await index.list_dir(virtual_key)
        if cached.entries is not None:
            return cached.entries
        raise FileNotFoundError(path)

    if depth == 3:
        if index is None:
            raise FileNotFoundError(path)
        cached = await index.list_dir(virtual_key)
        if cached.entries is not None:
            return cached.entries
        folder_vkey = PathSpec(
            original=prefix + "/" + parts[0],
            directory=prefix + "/" + parts[0],
            prefix=prefix,
        )
        await readdir(accessor, folder_vkey, index)
        cached = await index.list_dir(virtual_key)
        if cached.entries is not None:
            return cached.entries
        raise FileNotFoundError(path)

    raise FileNotFoundError(path)
