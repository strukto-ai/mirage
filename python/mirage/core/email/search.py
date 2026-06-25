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

from mirage.accessor.email import EmailAccessor
from mirage.core.email._client import fetch_message, list_message_uids
from mirage.core.email.readdir import _date_from_header, _sanitize
from mirage.core.email.scope import EmailScope


def build_search_criteria(
    text: str | None = None,
    subject: str | None = None,
    from_addr: str | None = None,
    to_addr: str | None = None,
    since: str | None = None,
    before: str | None = None,
    unseen: bool = False,
) -> str:
    parts: list[str] = []
    if unseen:
        parts.append("UNSEEN")
    if text:
        parts.append(f'TEXT "{text}"')
    if subject:
        parts.append(f'SUBJECT "{subject}"')
    if from_addr:
        parts.append(f'FROM "{from_addr}"')
    if to_addr:
        parts.append(f'TO "{to_addr}"')
    if since:
        parts.append(f"SINCE {since}")
    if before:
        parts.append(f"BEFORE {before}")
    return " ".join(parts) if parts else "ALL"


async def search_messages(
    accessor: EmailAccessor,
    folder: str,
    text: str | None = None,
    subject: str | None = None,
    from_addr: str | None = None,
    to_addr: str | None = None,
    since: str | None = None,
    before: str | None = None,
    unseen: bool = False,
    max_results: int | None = None,
) -> list[str]:
    criteria = build_search_criteria(
        text=text,
        subject=subject,
        from_addr=from_addr,
        to_addr=to_addr,
        since=since,
        before=before,
        unseen=unseen,
    )
    return await list_message_uids(accessor,
                                   folder,
                                   criteria,
                                   max_results=max_results)


def _build_vfs_path(prefix: str, folder: str, msg: dict) -> str:
    date_str = _date_from_header(msg.get("date", ""))
    subject = _sanitize(msg.get("subject", "No Subject"))
    uid = msg.get("uid", "")
    filename = f"{subject}__{uid}.email.json"
    parts = [prefix, folder, date_str, filename]
    return "/".join(p for p in parts if p)


async def search_and_format(
    accessor: EmailAccessor,
    scope: EmailScope,
    pattern: str,
    prefix: str,
    max_results: int | None = None,
) -> list[tuple[str, str]]:
    """Run native search and return (vfs_path, message_json) pairs."""
    folder = scope.folder or ""
    if not folder:
        return []
    uids = await search_messages(accessor,
                                 folder,
                                 text=pattern,
                                 max_results=max_results)
    pairs: list[tuple[str, str]] = []
    for uid in uids:
        msg = await fetch_message(accessor, folder, uid)
        msg_text = json.dumps(msg, ensure_ascii=False, separators=(",", ":"))
        vfs_path = _build_vfs_path(prefix, folder, msg)
        pairs.append((vfs_path, msg_text))
    return pairs
