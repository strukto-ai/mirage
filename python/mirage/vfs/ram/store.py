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
    """A RAM store's file table, keeping ``usage.used`` equal to the bytes
    it holds when a capacity caps the store.

    Counting here, rather than at each op, means no change to the table
    can miss the count. It does not refuse anything: an op checks growth
    with ``check_capacity`` before it stores, in the same synchronous
    step. Mirrors the TS ``RAMFiles``.
    """

    def __init__(self, usage: StorageUsage | None = None) -> None:
        self._data: dict[str, bytes] = {}
        self.usage = usage

    def _count(self, delta: int) -> None:
        if self.usage is not None and self.usage.used is not None:
            self.usage.used += delta

    def __getitem__(self, key: str) -> bytes:
        return self._data[key]

    def __setitem__(self, key: str, value: bytes) -> None:
        self._count(len(value) - len(self._data.get(key, b"")))
        self._data[key] = value

    def __delitem__(self, key: str) -> None:
        self._count(-len(self._data[key]))
        del self._data[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._data)

    def __len__(self) -> int:
        return len(self._data)

    def clear(self) -> None:
        self._data.clear()
        if self.usage is not None:
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
