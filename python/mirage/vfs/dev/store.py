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
from mirage.core.dev.mixin import PipeFiles
from mirage.core.dev.pipe import DevicePipe
from mirage.errors.fs import eacces, einval, enoent, fs_error
from mirage.errors.types import FsCondition
from mirage.vfs.dev.types import DevFileState, PipeRow
from mirage.vfs.ram.store import RAMStore

_DEV_NAMES = frozenset({"null", "zero"})
_T = TypeVar("_T")


class _PopMissing(Enum):
    TOKEN = 0


class DevFiles(dict[str, bytes], PipeFiles):
    """Real backing store plus a synthetic /null, /zero overlay.

    The synthetic device names read as empty/zeros and swallow writes until
    they are deleted (GNU: ``rm /dev/null`` succeeds and the path is gone).
    A deleted name is tombstoned; the next write stores real bytes, which
    is GNU's rm-then-redirect recreation as a regular file.

    A descriptor row holds a pipe and no bytes: reading or writing it as
    bytes is EINVAL, so an op that forgets its pipe branch fails instead
    of using bytes no reader sees, and removing it is EPERM (GNU: ``rm
    /dev/fd/63``), since only the scope that opened it releases it.
    Membership and listing still see it, and the bulk ``items``/``values``
    views count it as empty, a FIFO storing nothing.
    """

    def __init__(
        self, owner: str | None = None, state: DevFileState | None = None
    ) -> None:
        super().__init__()
        self._bound_owner = owner
        self.state = state if state is not None else DevFileState()

    def for_session(self, owner: str) -> "DevFiles":
        return DevFiles(owner, self.state)

    def _owner(self) -> str | None:
        if self._bound_owner is not None:
            return self._bound_owner
        session = get_current_session()
        return session.session_id if session is not None else None

    def _visible_inputs(self) -> dict[str, DevicePipe]:
        owner = self._owner()
        return {
            key: row.pipe
            for key, row in self.state.inputs.items()
            if row.owner == owner
        }

    def pipe_of(self, key: str) -> DevicePipe | None:
        row = self.state.inputs.get(key)
        return (
            row.pipe
            if row is not None and row.owner == self._owner()
            else None
        )

    def holds_pipe(self, key: str) -> bool:
        under = key.rstrip("/") + "/"
        return any(
            k == key or k.startswith(under) for k in self._visible_inputs()
        )

    def _listed_bytes(self, key: str) -> bytes:
        return b"" if key.startswith("/fd/") else self[key]

    def allocate_input(self, pipe: DevicePipe) -> tuple[str, int]:
        owner = self._owner()
        if owner is None:
            raise eacces("/dev/fd")
        fd = 63
        while f"/fd/{fd}" in self.state.inputs:
            fd -= 1
        key = f"/fd/{fd}"
        allocation = self.state.next_allocation
        self.state.next_allocation += 1
        self.state.inputs[key] = PipeRow(owner, allocation, pipe)
        return f"/dev{key}", allocation

    def release_input(self, path: str, allocation: int) -> bool:
        row = self.state.inputs.get(path[4:])
        if row is None or row.allocation != allocation:
            return False
        del self.state.inputs[path[4:]]
        return True

    def _synthetic_active(self, name: str) -> bool:
        return (
            name in _DEV_NAMES
            and name not in self.state.tombstones
            and ("/" + name) not in self.state.files
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
        if key in self.state.files:
            return True
        return self._synthetic_active(key.strip("/"))

    def __getitem__(self, key: str) -> bytes:
        if key.startswith("/fd/"):
            if self.pipe_of(key) is None:
                raise KeyError(key)
            raise einval(f"/dev{key}")
        if key in self.state.files:
            return self.state.files[key]
        name = key.strip("/")
        if self._synthetic_active(name):
            return b""
        raise KeyError(key)

    def __setitem__(self, key: str, value: bytes) -> None:
        if key == "/fd" or key.startswith("/fd/"):
            if self.pipe_of(key) is None:
                raise enoent(f"/dev{key}")
            raise einval(f"/dev{key}")
        name = key.strip("/")
        if self._synthetic_active(name):
            return
        self.state.files[key] = value
        self.state.tombstones.discard(name)

    def __delitem__(self, key: str) -> None:
        if key.startswith("/fd/"):
            if self.pipe_of(key) is None:
                raise enoent(f"/dev{key}")
            raise fs_error(f"/dev{key}", FsCondition.EPERM)
        name = key.strip("/")
        if key in self.state.files:
            del self.state.files[key]
            if name in _DEV_NAMES:
                self.state.tombstones.add(name)
            return
        if self._synthetic_active(name):
            self.state.tombstones.add(name)
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
        if key.startswith("/fd/"):
            raise fs_error(f"/dev{key}", FsCondition.EPERM)
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
        return [(key, self._listed_bytes(key)) for key in self.keys()]

    def values(self):
        return [self._listed_bytes(key) for key in self.keys()]

    def keys(self):
        return [
            *self._synthetic_names(),
            *self.state.files.keys(),
            *self._visible_inputs(),
        ]


class _DevDirs(set[str]):
    """Keep the virtual descriptor directory separate from ordinary writes."""

    def __init__(self, files: DevFiles) -> None:
        super().__init__()
        self._files = files

    def __len__(self) -> int:
        return len(self._files.state.dirs) + int("/fd" in self)

    def __contains__(self, key) -> bool:
        if key == "/fd":
            return bool(self._files._visible_inputs())
        return key in self._files.state.dirs

    def __iter__(self):
        return iter(
            [*self._files.state.dirs, *(["/fd"] if "/fd" in self else [])]
        )

    def add(self, key: str) -> None:
        if key == "/fd" or key.startswith("/fd/"):
            raise eacces(f"/dev{key}")
        self._files.state.dirs.add(key)

    def discard(self, key) -> None:
        if key == "/fd" or key.startswith("/fd/"):
            raise eacces(f"/dev{key}")
        self._files.state.dirs.discard(key)


class DevStore(RAMStore):
    files: DevFiles

    def __init__(self, files: DevFiles | None = None) -> None:
        self.files = files if files is not None else DevFiles()
        self.dirs = _DevDirs(self.files)
        self.modified = {}
        self.attrs = {}

    def for_session(self, owner: str) -> "DevStore":
        store = DevStore(self.files.for_session(owner))
        store.modified = self.modified
        store.attrs = self.attrs
        return store
