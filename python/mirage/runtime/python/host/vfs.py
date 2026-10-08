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
from collections.abc import Awaitable
from typing import TypeVar

from mirage.bridge.sync import run_async_from_sync
from mirage.runtime.constants import ABSENT_PATH
from mirage.runtime.python.host.errors import numbered
from mirage.runtime.types import VFSEntry, VFSStat
from mirage.runtime.vfs import stat_row
from mirage.workspace.files import Files

T = TypeVar("T")


class HostVFS:
    """The `with ws:` door: one call at a time over the ``Files`` facade.

    A guest's door (``RuntimeVFS``) hops to a workspace loop running on
    another thread. The block's code runs on the caller's own thread
    with no loop running, so this door drives the block's private loop
    for each call instead. Every call goes through the facade, which
    records it and binds the session, and an error the vocabulary can
    name comes back numbered as a real syscall's (``errors.numbered``).
    It also answers the questions an open asks (``runtime/open``).

    Args:
        files (Files): the facade every call goes through.
        loop (asyncio.AbstractEventLoop | None): the block's loop; None
            gives each call a throwaway loop.
    """

    def __init__(
        self, files: Files, loop: asyncio.AbstractEventLoop | None
    ) -> None:
        self.files = files
        self._loop = loop

    def run(self, coro: Awaitable[T]) -> T:
        """Run one facade coroutine to its result on the block's loop.

        Args:
            coro (Awaitable[T]): a call on ``self.ops``.
        """
        try:
            return run_async_from_sync(coro, self._loop)
        except OSError as exc:
            renumbered = numbered(exc)
            if renumbered is exc:
                raise
            raise renumbered from exc

    def stat_or_none(
        self, path: str, *, nofollow: bool = False
    ) -> VFSStat | None:
        try:
            row = self.run(self.files.stat(path, nofollow=nofollow))
        except ABSENT_PATH:
            return None
        return stat_row(row)

    def listing_or_none(self, path: str) -> list[VFSEntry] | None:
        try:
            names = self.run(self.files.readdir(path))
        except ABSENT_PATH:
            return None
        return [
            VFSEntry(path=name, size=0, is_dir=name.endswith("/"))
            for name in names
        ]

    def create(self, path: str) -> None:
        self.run(self.files.create(path))

    def truncate(self, path: str) -> None:
        self.run(self.files.truncate(path, 0))
