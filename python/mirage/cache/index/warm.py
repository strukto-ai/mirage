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
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.cache.index.config import IndexEntry, ListedMiss, LookupStatus
from mirage.cache.index.lock import index_lock
from mirage.cache.index.store import IndexCacheStore

logger = logging.getLogger(__name__)


async def entry_or_warm(
    index: IndexCacheStore,
    virtual_key: str,
    warm: Callable[[], Awaitable[Any]] | None,
) -> IndexEntry | None:
    """``entry_or_listed_miss`` for a caller that cannot ask by path.

    A complete listing that omits the key answers None, whoever fetched
    it.

    Args:
        index (IndexCacheStore): the index to read, and to warm through
            ``warm``.
        virtual_key (str): the index key being resolved.
        warm (Callable | None): lists the parent directory, populating the
            index; ``None`` when the key has no distinct parent to list.
    """
    found = await entry_or_listed_miss(index, virtual_key, warm)
    return None if found is ListedMiss.UNTRUSTED else found


async def entry_or_listed_miss(
    index: IndexCacheStore,
    virtual_key: str,
    warm: Callable[[], Awaitable[Any]] | None,
) -> IndexEntry | ListedMiss | None:
    """Resolve an entry when its parent listing is absent or expired.

    Id-addressed backends (Drive, Box, Dropbox, Gmail) can only turn a path
    into an id through the index, so a cold lookup has to warm it from the
    parent's listing and retry. Every such backend had grown its own copy of
    that block; this is the one place that decides what a failed listing means.

    A missing parent listing does not prove a retained entry is current: a
    partial warm may have stored the child without publishing freshness.
    Such a child is dropped before the refresh. A fresh partial listing
    proves only the children it names; an omitted child still refreshes.
    A parent that is simply absent is not an error here -- the caller reports
    ENOENT against the operand,
    which is the path GNU names (``rm nodir/f`` says "cannot remove 'nodir/f'",
    not "nodir"). Every other failure propagates: an expired token or a
    dropped connection reported as "no such file" both misdiagnoses the fault
    and hides that it is worth retrying.

    A complete listing that omits the key answers without a warm: None
    when the running command fetched it, ``ListedMiss.UNTRUSTED`` when it
    did not, so a backend that can ask by path learns whether the miss is
    proof.

    Args:
        index (IndexCacheStore): the index to read, and to warm through
            ``warm``.
        virtual_key (str): the index key being resolved.
        warm (Callable | None): lists the parent directory, populating the
            index; ``None`` when the key has no distinct parent to list.
    """
    parent = virtual_key.rstrip("/").rsplit("/", 1)[0] or "/"
    async with index_lock(index, parent):
        listing = await index.list_dir(parent)
        if listing.entries is not None and virtual_key not in listing.entries:
            if index.listed_this_command(parent):
                return None
            return ListedMiss.UNTRUSTED
        hit = await index.get(virtual_key)
        if hit.entry is not None and (
            listing.entries is not None
            or virtual_key in (listing.partial_entries or [])
        ):
            return hit.entry
        if warm is None:
            return None
        if listing.status == LookupStatus.EXPIRED:
            # Retained metadata is not proof of existence. Drop old children
            # before warming, even when a partial listing only puts rows.
            await index.invalidate_dir(parent)
        if hit.entry is not None:
            # Partial listings can leave untracked rows that invalidate_dir
            # cannot remove. A refresh that omits this path must not reuse one.
            await index.invalidate_prefix(virtual_key)
        try:
            await warm()
        except FileNotFoundError as exc:
            logger.debug("index warm failed for %s: %s", virtual_key, exc)
            return None
        listing = await index.list_dir(parent)
        if listing.entries is not None and virtual_key not in listing.entries:
            return None
        warmed = await index.get(virtual_key)
        return warmed.entry
