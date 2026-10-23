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

from mirage.accessor.gmail import GmailAccessor
from mirage.core.gmail.messages import message_json_bytes
from mirage.core.gmail.scope import detect_scope
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.errors.fs import enoent
from mirage.types import FileStat, PathSpec


async def _read_message(
    accessor: GmailAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    if entry is None:
        raise enoent(path.virtual)
    raw = await accessor.gmail.get_message_raw(str(entry.extra["message_id"]))
    return message_json_bytes(raw)


async def _read_attachment(
    accessor: GmailAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    # The message id decodes from the attachment dir's `subject__id`
    # segment; the attachment id only exists in the listing, so the row
    # stays the proof of existence AND the id source.
    if entry is None:
        raise enoent(path.virtual)
    return await accessor.gmail.get_attachment(
        match.slots["message_id"],
        str(entry.extra["attachment_id"]),
    )


read = make_read(
    detect_scope,
    readers={
        "message": _read_message,
        "attachment": _read_attachment,
    },
)
