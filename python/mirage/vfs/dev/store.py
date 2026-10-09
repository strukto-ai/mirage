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

from collections.abc import Iterator
from enum import Enum
from typing import TypeVar, overload

from mirage.context import get_current_session
from mirage.errors.fs import eacces, enoent
from mirage.vfs.ram.store import RAMStore

_DEV_NAMES = frozenset({"null", "zero"})
_T = TypeVar("_T")


class _PopMissing(Enum):
    TOKEN = 0


class DevFiles(dict[str, bytes]):
    """Real backing store plus a synthetic /null, /zero overlay.

    The synthetic device names read as empty/zeros and swallow writes until
    they are deleted (GNU: ``rm /dev/null`` succeeds and the path is gone).
    A deleted name is tombstoned; the next write stores real bytes, which
    is GNU's rm-then-redirect recreation as a regular file.
    """

    def __init__(self) -> None:
        super().__init__()
        self._tombstones: set[str] = set()
        self._inputs: dict[str, tuple[str, int, bytes]] = {}
        self._next_allocation = 0

    def _visible_inputs(self) -> dict[str, bytes]:
        session = get_current_session()
        if session is None:
            return {}
        return {
            key: data
            for key, (owner, _, data) in self._inputs.items()
            if owner == session.session_id
        }

    def allocate_input(self) -> tuple[str, int]:
        session = get_current_session()
        if session is None:
            raise eacces("/dev/fd")
        fd = 63
        while f"/fd/{fd}" in self._inputs:
            fd -= 1
        key = f"/fd/{fd}"
        allocation = self._next_allocation
        self._next_allocation += 1
        self._inputs[key] = (session.session_id, allocation, b"")
        return f"/dev{key}", allocation

    def set_input(self, path: str, allocation: int, data: bytes) -> None:
        row = self._inputs.get(path[4:])
        if row is None or row[1] != allocation:
            raise enoent(path)
        self[path[4:]] = data

    def release_input(self, path: str, allocation: int) -> bool:
        row = self._inputs.get(path[4:])
        if row is None or row[1] != allocation:
            return False
        del self._inputs[path[4:]]
        return True

    def _synthetic_active(self, name: str) -> bool:
        return (
            name in _DEV_NAMES
            and name not in self._tombstones
            and not dict.__contains__(self, "/" + name)
        )

    def _synthetic_names(self) -> list[str]:
        return [
            "/" + name
            for name in ("null", "zero")
            if self._synthetic_active(name)
        ]

    def device_of(self, key: str) -> str | None:
        # The state-based authority on "is this an active char device":
        # a tombstoned-then-recreated path is a real file, not a device.
        name = key.strip("/")
        return name if self._synthetic_active(name) else None

    def __contains__(self, key: _T) -> bool:
        if not isinstance(key, str):
            return False
        if key.startswith("/fd/"):
            return key in self._visible_inputs()
        if dict.__contains__(self, key):
            return True
        return self._synthetic_active(key.strip("/"))

    def __getitem__(self, key: str) -> bytes:
        if key.startswith("/fd/"):
            return self._visible_inputs()[key]
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        name = key.strip("/")
        if self._synthetic_active(name):
            return b""
        raise KeyError(key)

    def __setitem__(self, key: str, value: bytes) -> None:
        if key == "/fd" or key.startswith("/fd/"):
            if key not in self._visible_inputs():
                raise enoent(f"/dev{key}")
            owner, allocation, _ = self._inputs[key]
            self._inputs[key] = (owner, allocation, value)
            return
        name = key.strip("/")
        if self._synthetic_active(name):
            return
        dict.__setitem__(self, key, value)
        self._tombstones.discard(name)

    def __delitem__(self, key: str) -> None:
        if key.startswith("/fd/"):
            if key not in self._visible_inputs():
                raise enoent(f"/dev{key}")
            del self._inputs[key]
            return
        name = key.strip("/")
        if dict.__contains__(self, key):
            dict.__delitem__(self, key)
            if name in _DEV_NAMES:
                self._tombstones.add(name)
            return
        if self._synthetic_active(name):
            self._tombstones.add(name)
            return
        raise KeyError(key)

    @overload
    def pop(self, key: str, /) -> bytes: ...

    @overload
    def pop(self, key: str, default: bytes, /) -> bytes: ...

    @overload
    def pop(self, key: str, default: _T, /) -> bytes | _T: ...

    def pop(
        self, key: str, default: _T | _PopMissing = _PopMissing.TOKEN, /
    ) -> bytes | _T:
        if key not in self:
            if default is _PopMissing.TOKEN:
                raise KeyError(key)
            return default
        value = self[key]
        del self[key]
        return value

    def __iter__(self) -> Iterator[str]:
        return iter(self.keys())

    def __len__(self) -> int:
        return len(self.keys())

    def get(self, key, default=None):
        return self[key] if key in self else default

    def items(self):
        return [(key, self[key]) for key in self.keys()]

    def values(self):
        return [self[key] for key in self.keys()]

    def keys(self):
        return [
            *self._synthetic_names(),
            *dict.keys(self),
            *self._visible_inputs(),
        ]


class _DevDirs(set[str]):
    """Keep the virtual descriptor directory separate from ordinary writes."""

    def __init__(self, files: DevFiles) -> None:
        super().__init__({"/"})
        self._files = files

    def __contains__(self, key) -> bool:
        if key == "/fd":
            return bool(self._files._visible_inputs())
        return super().__contains__(key)

    def __iter__(self):
        return iter([*super().__iter__(), *(["/fd"] if "/fd" in self else [])])

    def add(self, key: str) -> None:
        if key == "/fd" or key.startswith("/fd/"):
            raise eacces(f"/dev{key}")
        super().add(key)

    def discard(self, key) -> None:
        if key == "/fd" or key.startswith("/fd/"):
            raise eacces(f"/dev{key}")
        super().discard(key)


class DevStore(RAMStore):
    files: DevFiles

    def __init__(self) -> None:
        self.files = DevFiles()
        self.dirs = _DevDirs(self.files)
        self.modified = {}
        self.attrs = {}
