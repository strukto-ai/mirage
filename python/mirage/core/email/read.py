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

from mirage.accessor.email import EmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.email.client import fetch_attachment, fetch_message
from mirage.core.email.readdir import readdir
from mirage.core.email.render import message_json_bytes
from mirage.core.email.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.errors.fs import enoent
from mirage.types import PathSpec


async def _read_message(
    accessor: EmailAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is None:
        raise enoent(path.virtual)
    msg = await fetch_message(accessor, match.slots["folder"], entry.id)
    return message_json_bytes(msg)


async def _read_attachment(
    accessor: EmailAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is None:
        raise enoent(path.virtual)
    data = await fetch_attachment(
        accessor, match.slots["folder"], match.slots["uid"], entry.vfs_name
    )
    if data is None:
        raise enoent(path.virtual)
    return data


read = make_read(
    detect_scope,
    readers={
        "message": _read_message,
        "attachment": _read_attachment,
    },
)
