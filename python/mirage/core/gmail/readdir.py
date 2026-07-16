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
from datetime import datetime, timezone

from mirage.accessor.gmail import GmailAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.gmail.date_query import date_dir_to_gmail_query
from mirage.core.gmail.labels import list_labels
from mirage.core.gmail.messages import (_extract_attachments, _extract_header,
                                        get_message_raw, list_messages)
from mirage.core.google.drive import GoogleFileSuffix
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


def is_dir_name(child: str) -> bool:
    # readdir emits only label/date dirs and rendered *.gmail.json files.
    return not child.endswith(GoogleFileSuffix.GMAIL.value)


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


def _msg_filename(subject: str, msg_id: str) -> str:
    return f"{_sanitize(subject)}__{msg_id}.gmail.json"


def _attach_dir_name(subject: str, msg_id: str) -> str:
    return f"{_sanitize(subject)}__{msg_id}"


def _attachment_filename(_attachment_id: str, filename: str) -> str:
    return filename or "file"


def _date_from_internal(internal_date: str) -> str:
    ts = int(internal_date) / 1000
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


async def _build_date_groups(
    accessor: GmailAccessor,
    msg_ids: list[dict],
    index: IndexCacheStore,
    virtual_key: str,
    write_dates: bool,
) -> list[tuple[str, IndexEntry]]:
    date_groups: dict[str, list[dict]] = {}
    for m in msg_ids:
        mid = m["id"]
        raw = await get_message_raw(accessor.token_manager, mid)
        internal_date = raw.get("internalDate", "0")
        date_str = _date_from_internal(internal_date)
        date_groups.setdefault(date_str, []).append(raw)
    date_entries: list[tuple[str, IndexEntry]] = []
    for date_str in sorted(date_groups.keys(), reverse=True):
        date_entry = IndexEntry(
            id=date_str,
            name=date_str,
            resource_type="gmail/date",
            vfs_name=date_str,
        )
        date_entries.append((date_str, date_entry))
        date_children: list[tuple[str, IndexEntry]] = []
        for raw in date_groups[date_str]:
            mid = raw["id"]
            headers = raw.get("payload", {}).get("headers", [])
            subject = _extract_header(headers, "Subject") or "No Subject"
            filename = _msg_filename(subject, mid)
            size_estimate = raw.get("sizeEstimate")
            # size stays None: sizeEstimate is the source message size, not
            # the rendered .gmail.json length (FileStat.size must be
            # render-derived or None, see the CLAUDE.md FUSE rules). The
            # estimate lives in extra.
            msg_entry = IndexEntry(
                id=mid,
                name=subject,
                resource_type="gmail/message",
                vfs_name=filename,
                extra={"size_estimate": size_estimate}
                if size_estimate is not None else {},
            )
            date_children.append((filename, msg_entry))
            attachments = _extract_attachments(raw.get("payload", {}))
            if attachments:
                att_dir = _attach_dir_name(subject, mid)
                att_dir_entry = IndexEntry(
                    id=mid,
                    name=att_dir,
                    resource_type="gmail/attachment_dir",
                    vfs_name=att_dir,
                )
                date_children.append((att_dir, att_dir_entry))
                att_entries: list[tuple[str, IndexEntry]] = []
                for att in attachments:
                    att_name = _attachment_filename(att["attachment_id"],
                                                    att["filename"])
                    att_entry = IndexEntry(
                        id=att["attachment_id"],
                        name=att["filename"],
                        resource_type="gmail/attachment",
                        vfs_name=att_name,
                        size=att["size"],
                    )
                    att_entries.append((att_name, att_entry))
                att_vkey = virtual_key + "/" + date_str + "/" + att_dir
                if index is not None and write_dates:
                    await index.set_dir(att_vkey, att_entries)
        if index is not None and write_dates:
            await index.set_dir(virtual_key + "/" + date_str, date_children)
    return date_entries


async def readdir(
    accessor: GmailAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
    key = path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"
    parts = key.split("/") if key else []
    depth = len(parts)

    if depth == 0:
        if index is not None:
            cached = await index.list_dir(virtual_key)
            if cached.entries is not None:
                return cached.entries
        labels = await list_labels(accessor.token_manager)
        entries = []
        for lb in labels:
            if lb.get("type") == "system":
                name = lb["id"]
            else:
                name = lb.get("name", lb["id"])
            entry = IndexEntry(
                id=lb["id"],
                name=name,
                resource_type="gmail/label",
                vfs_name=name,
            )
            entries.append((name, entry))
        if index is not None:
            await index.set_dir(virtual_key, entries)
        return [f"{prefix}/{name}" for name, _ in entries]

    if depth == 1:
        label_name = parts[0]
        if index is not None:
            cached = await index.list_dir(virtual_key)
            if cached.entries is not None:
                return cached.entries
        label_key = prefix + "/" + label_name if prefix else "/" + label_name
        result = await index.get(label_key)
        if result.entry is None:
            # Auto-bootstrap: populate label index.
            try:
                root = PathSpec(
                    virtual=prefix or "/",
                    directory=prefix or "/",
                    resource_path=mount_key(prefix or "/", prefix),
                )
                await readdir(accessor, root, index)
                result = await index.get(label_key)
            except Exception as e:
                logger.debug(
                    "gmail readdir: bootstrap failed for %s: %s",
                    label_key,
                    e,
                )
        if result.entry is None:
            raise enoent(virtual)
        label_id = result.entry.id
        msg_ids = await list_messages(
            accessor.token_manager,
            label_id=label_id,
            max_results=50,
        )
        date_entries = await _build_date_groups(
            accessor,
            msg_ids,
            index,
            virtual_key,
            write_dates=True,
        )
        if index is not None:
            await index.set_dir(virtual_key, date_entries)
        return [f"{prefix}/{key}/{name}" for name, _ in date_entries]

    if depth == 2:
        cached = await index.list_dir(virtual_key)
        if cached.entries is not None:
            return cached.entries
        label_name = parts[0]
        date_str = parts[1]
        date_query = date_dir_to_gmail_query(date_str)
        if date_query is not None:
            label_key = (prefix + "/" + label_name if prefix else "/" +
                         label_name)
            label_result = await index.get(label_key)
            if label_result.entry is None:
                try:
                    root = PathSpec(
                        virtual=prefix or "/",
                        directory=prefix or "/",
                        resource_path=mount_key(prefix or "/", prefix),
                    )
                    await readdir(accessor, root, index)
                    label_result = await index.get(label_key)
                except Exception as e:
                    logger.debug(
                        "gmail readdir: date-dir bootstrap failed for %s: %s",
                        label_key,
                        e,
                    )
            if label_result.entry is not None:
                label_id = label_result.entry.id
                label_vkey = label_key
                msg_ids = await list_messages(
                    accessor.token_manager,
                    label_id=label_id,
                    query=date_query,
                    max_results=50,
                )
                await _build_date_groups(
                    accessor,
                    msg_ids,
                    index,
                    label_vkey,
                    write_dates=True,
                )
                if not msg_ids:
                    await index.set_dir(virtual_key, [])
                cached = await index.list_dir(virtual_key)
                if cached.entries is not None:
                    return cached.entries
                raise enoent(virtual)
        label_path = prefix + "/" + parts[0] if prefix else "/" + parts[0]
        await readdir(
            accessor,
            PathSpec.from_str_path(label_path, mount_key(label_path, prefix)),
            index)
        cached = await index.list_dir(virtual_key)
        if cached.entries is not None:
            return cached.entries
        raise enoent(virtual)

    if depth == 3:
        cached = await index.list_dir(virtual_key)
        if cached.entries is not None:
            return cached.entries
        date_path = (prefix + "/" + parts[0] + "/" +
                     parts[1] if prefix else "/" + parts[0] + "/" + parts[1])
        await readdir(
            accessor,
            PathSpec.from_str_path(date_path, mount_key(date_path, prefix)),
            index)
        cached = await index.list_dir(virtual_key)
        if cached.entries is not None:
            return cached.entries
        raise enoent(virtual)

    raise enoent(virtual)
