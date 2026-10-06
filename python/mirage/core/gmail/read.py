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
from mirage.cache.index import IndexCacheStore
from mirage.core.gmail.messages import (
    get_attachment,
    get_message_raw,
    message_json_bytes,
)
from mirage.core.gmail.readdir import readdir
from mirage.core.gmail.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.errors.fs import enoent
from mirage.types import PathSpec


async def _read_message(
    accessor: GmailAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is None:
        raise enoent(path.virtual)
    raw = await get_message_raw(accessor.token_manager, entry.id)
    return message_json_bytes(raw)


async def _read_attachment(
    accessor: GmailAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    # The message id decodes from the attachment dir's `subject__id`
    # segment; the attachment id only exists in the listing, so the
    # entry stays the proof of existence AND the id source.
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is None:
        raise enoent(path.virtual)
    return await get_attachment(
        accessor.token_manager, match.slots["message_id"], entry.id
    )


read = make_read(
    detect_scope,
    readers={
        "message": _read_message,
        "attachment": _read_attachment,
    },
)
