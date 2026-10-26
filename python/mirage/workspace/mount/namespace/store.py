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

import asyncio
from abc import ABC, abstractmethod
from collections.abc import Iterable

from mirage.workspace.record.types import RecordClient, RecordFields

NodeFields = dict[str, str | int | float | None]


class NamespaceStore(ABC):
    """Storage seam for mirage's own state: one keyed table of JSON
    records.

    A workspace keeps two of them: the node table (symlinks and the
    attribute overlay, keyed by virtual path) and the session table
    (env, cwd, functions and mount grants, keyed by session id). The
    owner keeps the working copy in memory, hydrates once from the
    store, and writes through on mutation, so both survive process
    restarts and are visible to any workspace pointed at the same
    store. Subclasses are infra adapters (RAM, disk, Redis, a keyed
    record client); everything above (symlinks, the overlay, sessions,
    snapshots) is storage-agnostic, mirroring the ObserverStore design.
    """

    @abstractmethod
    async def load(self) -> dict[str, RecordFields]:
        """Read every stored record (hydration at first use).

        Returns:
            dict[str, RecordFields]: key to record fields.
        """
        raise NotImplementedError

    @abstractmethod
    async def set(self, key: str, fields: RecordFields) -> None:
        """Upsert one record.

        Args:
            key (str): a virtual path or a session id.
            fields (RecordFields): full field set for the record.
        """
        raise NotImplementedError

    @abstractmethod
    async def cas_set(
        self, key: str, fields: RecordFields, expected_generation: int
    ) -> bool:
        """Write one record iff its stored generation matches.

        Optimistic concurrency for the session flush: the write lands
        only when the stored record's ``generation`` equals
        ``expected_generation`` (a missing record and a record without
        the field both count as generation 0). ``replace_all`` stays
        unchecked on purpose: a snapshot restore wins wholesale.

        Args:
            key (str): record to write.
            fields (RecordFields): full record, already carrying the
                bumped generation.
            expected_generation (int): generation the caller last saw.

        Returns:
            bool: True when the write landed, False on conflict.
        """
        raise NotImplementedError

    @abstractmethod
    async def delete(self, keys: Iterable[str]) -> None:
        """Drop records; missing keys are ignored.

        Args:
            keys (Iterable[str]): keys to remove.
        """
        raise NotImplementedError

    @abstractmethod
    async def replace_all(self, entries: dict[str, RecordFields]) -> None:
        """Overwrite the whole table (snapshot restore).

        Args:
            entries (dict[str, RecordFields]): the new table.
        """
        raise NotImplementedError

    @abstractmethod
    async def clear(self) -> None:
        """Delete every stored record."""
        raise NotImplementedError

    @abstractmethod
    async def close(self) -> None:
        """Release any held connections or handles."""
        raise NotImplementedError


class RecordNamespaceStore(NamespaceStore):
    """A NamespaceStore over a keyed-record client, one record per key.

    The disk and S3 session tables differ only in the client they hand
    in.

    Args:
        records (RecordClient): the client holding the records.
    """

    def __init__(self, records: RecordClient) -> None:
        self._records = records

    async def load(self) -> dict[str, RecordFields]:
        names = await self._records.list_names()
        records = await asyncio.gather(
            *(self._records.get(name) for name in names)
        )
        return {
            name: fields
            for name, (fields, _) in zip(names, records)
            if fields is not None
        }

    async def set(self, key: str, fields: RecordFields) -> None:
        await self._records.put(key, fields)

    async def cas_set(
        self, key: str, fields: RecordFields, expected_generation: int
    ) -> bool:
        return await self._records.cas_put(key, fields, expected_generation)

    async def delete(self, keys: Iterable[str]) -> None:
        await self._records.delete(keys)

    async def replace_all(self, entries: dict[str, RecordFields]) -> None:
        stale = set(await self._records.list_names()) - set(entries)
        await self._records.delete(stale)
        await asyncio.gather(
            *(
                self._records.put(key, fields)
                for key, fields in entries.items()
            )
        )

    async def clear(self) -> None:
        await self._records.clear()

    async def close(self) -> None:
        await self._records.close()
