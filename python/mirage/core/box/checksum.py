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

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import writes_conditioned
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.box.api import get_file_info
from mirage.core.box.constants import SHA1
from mirage.core.box.fingerprint import read_token, token_of
from mirage.core.box.read import file_entry
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def checksum(
    accessor: BoxAccessor,
    path: PathSpec,
    algorithm: str,
    index: IndexCacheStore = NULL_INDEX,
) -> str | None:
    """The sha1 Box keeps for a file's content, asked live.

    A listing row's sha1 can be older than the bytes a read downloads,
    so the file's own record is asked. Box keeps no other digest. A
    digest answered is recorded as the read it stands in for, with the
    token a whole read of those bytes would record.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the file.
        algorithm (str): the hashlib name asked for.
        index (IndexCacheStore): listing cache, consulted for the file id.
    """
    if algorithm != SHA1:
        return None
    entry = await file_entry(accessor, path, index)
    timer = start_op()
    item = await get_file_info(accessor.token_manager, entry.id)
    found = token_of(item.get(SHA1))
    if found is None:
        return None
    digest = found.lower()
    record(
        "read",
        path.virtual,
        "box",
        0,
        timer,
        fingerprint=(
            digest if writes_conditioned() else read_token(entry, digest)
        ),
    )
    return digest
