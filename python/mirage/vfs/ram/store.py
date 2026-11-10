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

from collections.abc import Iterable, Iterator, MutableMapping
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeVar, overload

from mirage.vfs.capacity import StorageUsage

_T = TypeVar("_T")


class _FileStore(Protocol):
    def __contains__(self, key: str, /) -> bool: ...
    def __iter__(self) -> Iterator[str]: ...
    def __getitem__(self, key: str, /) -> bytes: ...
    def __setitem__(self, key: str, value: bytes, /) -> None: ...
    def __delitem__(self, key: str, /) -> None: ...
    def keys(self) -> Iterable[str]: ...
    def clear(self) -> None: ...
    def size(self, key: str, /) -> int: ...
    def splice(self, key: str, offset: int, data: bytes, /) -> None: ...

    @overload
    def get(self, key: str, /) -> bytes | None: ...

    @overload
    def get(self, key: str, default: bytes, /) -> bytes: ...

    @overload
    def get(self, key: str, default: _T, /) -> bytes | _T: ...

    @overload
    def pop(self, key: str, /) -> bytes: ...

    @overload
    def pop(self, key: str, default: bytes, /) -> bytes: ...

    @overload
    def pop(self, key: str, default: _T, /) -> bytes | _T: ...


class RAMFiles(MutableMapping[str, bytes]):
    """A RAM store's file table, keeping ``held`` equal to the bytes it
    holds, and ``usage.used`` too when a capacity caps the store.

    Counting here, rather than at each op, means no change to the table
    can miss the count; the workspace's ``max_memory`` sums ``held``. It
    does not refuse anything: an op checks growth with ``check_capacity``
    before it stores, under ``RAMStore.lock``, as one step.

    A file ``splice`` changed is a ``bytearray`` it grows and overwrites
    where it lies, so a run of appends or pwrites copies nothing; a read
    takes a ``bytes`` copy, kept in its place until the next change, so
    a reader holds what was there when it read. Mirrors the TS
    ``RAMFiles``.
    """

    def __init__(self, usage: StorageUsage | None = None) -> None:
        self._data: dict[str, bytes | bytearray] = {}
        self.usage = usage
        self.held = 0

    def _count(self, delta: int) -> None:
        self.held += delta
        if self.usage is not None:
            self.usage.land(0, delta)

    def __contains__(self, key: _T) -> bool:
        return key in self._data

    def __getitem__(self, key: str) -> bytes:
        data = self._data[key]
        if isinstance(data, bytearray):
            data = self._data[key] = bytes(data)
        return data

    def __setitem__(self, key: str, value: bytes) -> None:
        self._count(len(value) - self.size(key))
        self._data[key] = bytes(value)

    def size(self, key: str) -> int:
        """A key's length without copying it, 0 for a missing one.

        Args:
            key (str): the store key.
        """
        return len(self._data.get(key, b""))

    def splice(self, key: str, offset: int, data: bytes) -> None:
        """Write ``data`` at ``offset`` of ``key`` in place, as pwrite(2)
        leaves a file: a gap past its end reads as NULs, a missing key is
        created, and writing nothing changes nothing.

        Args:
            key (str): the store key.
            offset (int): where the bytes land.
            data (bytes): the bytes to write.
        """
        buffer = self._data.setdefault(key, b"")
        if not data:
            return
        if not isinstance(buffer, bytearray):
            buffer = self._data[key] = bytearray(buffer)
        before = len(buffer)
        buffer.extend(bytes(max(offset - before, 0)))
        buffer[offset : offset + len(data)] = data
        self._count(len(buffer) - before)

    def __delitem__(self, key: str) -> None:
        self._count(-len(self._data[key]))
        del self._data[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._data)

    def __len__(self) -> int:
        return len(self._data)

    def clear(self) -> None:
        if self.usage is None:
            self._data.clear()
            self.held = 0
            return
        with self.usage.lock:
            self._data.clear()
            self.held = 0
            self.usage.used = 0


@dataclass
class RAMStore:
    files: _FileStore = field(default_factory=RAMFiles)
    dirs: set[str] = field(default_factory=lambda: {"/"})
    modified: dict[str, str] = field(default_factory=dict)
    # Per-path metadata set via setattr (mode/uid/gid/atime); stored, not
    # enforced: mount mode does real access control.
    attrs: dict[str, dict[str, Any]] = field(default_factory=dict[str, Any])
    # The store's capacity and counted bytes, None when uncapped.
    usage: StorageUsage | None = None

    @property
    def lock(self) -> AbstractContextManager[bool | None]:
        """What a step that reads a key, checks its growth and stores it
        holds, so the three run as one across threads: the count's lock
        when a capacity caps the store, nothing otherwise."""
        return self.usage.lock if self.usage is not None else nullcontext()
