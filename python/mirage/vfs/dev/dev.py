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

from typing import TypeVar, overload

from mirage.accessor.ram import RAMAccessor
from mirage.commands.builtin.dev import COMMANDS
from mirage.ops.dev import OPS as DEV_OPS
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram.store import RAMStore

_DEV_NAMES = frozenset({"null", "zero"})
_POP_MISSING = object()
_T = TypeVar("_T")


class _DevFiles(dict[str, bytes]):
    """Real backing store plus a synthetic /null, /zero overlay.

    The synthetic device names read as empty/zeros and swallow writes until
    they are deleted (GNU: ``rm /dev/null`` succeeds and the path is gone).
    A deleted name is tombstoned; the next write stores real bytes, which
    is GNU's rm-then-redirect recreation as a regular file.
    """

    def __init__(self) -> None:
        super().__init__()
        self._tombstones: set[str] = set()

    def _synthetic_active(self, name: str) -> bool:
        return (name in _DEV_NAMES and name not in self._tombstones
                and not dict.__contains__(self, "/" + name))

    def _synthetic_names(self) -> list[str]:
        return [
            "/" + name for name in ("null", "zero")
            if self._synthetic_active(name)
        ]

    def device_of(self, key: str) -> str | None:
        # The state-based authority on "is this an active char device":
        # a tombstoned-then-recreated path is a real file, not a device.
        name = key.strip("/")
        return name if self._synthetic_active(name) else None

    def __contains__(self, key: object) -> bool:
        if not isinstance(key, str):
            return False
        if dict.__contains__(self, key):
            return True
        return self._synthetic_active(key.strip("/"))

    def __getitem__(self, key: str) -> bytes:
        if dict.__contains__(self, key):
            return dict.__getitem__(self, key)
        name = key.strip("/")
        if self._synthetic_active(name):
            return b""
        raise KeyError(key)

    def __setitem__(self, key: str, value: bytes) -> None:
        name = key.strip("/")
        if self._synthetic_active(name):
            return
        dict.__setitem__(self, key, value)
        self._tombstones.discard(name)

    def __delitem__(self, key: str) -> None:
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
    def pop(self, key: str, /) -> bytes:
        ...

    @overload
    def pop(self, key: str, default: bytes, /) -> bytes:
        ...

    @overload
    def pop(self, key: str, default: _T, /) -> bytes | _T:
        ...

    def pop(self, key: str, default: object = _POP_MISSING, /) -> object:
        if key not in self:
            if default is _POP_MISSING:
                raise KeyError(key)
            return default
        value = self[key]
        del self[key]
        return value

    def __iter__(self):
        return iter([*self._synthetic_names(), *dict.__iter__(self)])

    def __len__(self) -> int:
        return len(self._synthetic_names()) + dict.__len__(self)

    def keys(self):
        return [*self._synthetic_names(), *dict.keys(self)]


class DevStore(RAMStore):

    def __init__(self) -> None:
        self.files = _DevFiles()
        self.dirs = {"/"}
        self.modified = {}
        self.attrs = {}


class DevVFS(BaseVFS):

    accessor: RAMAccessor
    name: str = VFSName.RAM
    # Device metadata is synthetic and needs no content fetch.
    SIZES_ALWAYS_KNOWN: bool = True

    def __init__(self) -> None:
        super().__init__()
        self._store = DevStore()
        self.accessor = RAMAccessor(self._store)
        for fn in COMMANDS:
            self.register(fn)
        for ro in DEV_OPS:
            self.register_op(ro)
