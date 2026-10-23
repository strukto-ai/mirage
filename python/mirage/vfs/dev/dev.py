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

from collections.abc import AsyncIterator, Awaitable
from typing import Any

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.device import active_pipe
from mirage.core.dev.pipe import DevicePipe
from mirage.core.dev.read import read as dev_read
from mirage.core.dev.stat import key_stat
from mirage.core.dev.stat import stat as dev_stat
from mirage.core.ram.readdir import child_keys
from mirage.io.types import ByteSource
from mirage.types import FileStat, FileType, PathSpec, VFSName
from mirage.utils.path import norm
from mirage.vfs.dev.store import DevStore
from mirage.vfs.ram.ram import RAMVFS


class DevVFS(RAMVFS):
    """``/dev``: a RAM mount whose read and stat know the two synthetic
    character devices, ``null`` and ``zero``.

    Its stream is finite: a command that consumes a whole input reads the
    refusing read, and only the two bounded streaming commands opt into
    the endless source (``commands/builtin/dev``).
    """

    accessor: RAMAccessor
    _store: DevStore
    name: str = VFSName.RAM
    prompt: str = ""
    # Device metadata is synthetic and needs no content fetch.
    sizes_always_known: bool = True

    def __init__(self, store: DevStore | None = None) -> None:
        super().__init__()
        self._store = store if store is not None else DevStore()
        self.accessor = RAMAccessor(self._store)

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        """The RAM listing, each child as ``stat`` answers it, so a
        device or a live descriptor lists as one.

        Args:
            path (PathSpec): the directory.
        """
        return [
            key_stat(self.accessor, key)
            or FileStat(name=key.rsplit("/", 1)[-1], type=FileType.DIRECTORY)
            for key in await child_keys(self.accessor, path)
        ]

    def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> Awaitable[ByteSource] | AsyncIterator[bytes]:
        # Not a coroutine, so a pipe is bound as the read opens and a
        # descriptor reads on after the pipe's path is released.
        if not offset and size is None:
            pipe = active_pipe(self.accessor, norm(path.mount_path))
            if pipe is not None:
                return pipe.stream(path)
        return dev_read(self.accessor, path, offset, size)

    async def stat(self, path: PathSpec) -> FileStat:
        return await dev_stat(self.accessor, path)

    async def read_tree(self, path: PathSpec) -> dict[str, FileStat] | None:
        """None: a walk of /dev is one readdir.

        Args:
            path (PathSpec): the directory.
        """
        return None

    def get_state(self) -> dict[str, Any]:
        return {"type": self.name}

    def load_state(self, state: dict[str, Any]) -> None:
        """Nothing to restore: the devices are synthetic.

        Args:
            state (dict[str, Any]): the payload ``get_state`` produced.
        """

    def for_session(self, owner: str) -> "DevVFS":
        return DevVFS(self._store.for_session(owner))

    def allocate_input(self, pipe: DevicePipe) -> tuple[str, int]:
        return self._store.files.allocate_input(pipe)

    def release_input(self, path: str, allocation: int) -> None:
        if self._store.files.release_input(path, allocation):
            self._store.modified.pop(path[4:], None)
            self._store.attrs.pop(path[4:], None)
