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
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from mirage.accessor.machine import MachineAccessor
from mirage.core.machine import place
from mirage.core.machine.unlink import unlink as _unlink
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


def _removal_slot(path: PathSpec, machine: str) -> str:
    """The key a removal of a name on a machine is under while it runs.

    Args:
        path (PathSpec): the name.
        machine (str): the machine.
    """
    return f"{machine}\0{path.virtual}"


class LiveWrites:
    """The writes landing on a machine mount's names, kept so that once
    the writes of a name end, one copy of it shows, the newest. A write
    that replaces a name settles it: every other machine's copy goes
    (``_settle``). A machine still writing the name keeps its copy, and
    the last write of the name to end settles it again, a failed one too.
    A write waits for a removal of its name on its machine that is under
    way, so the removal never takes the new copy.

    Args:
        accessor (MachineAccessor): the mount's machines.
    """

    def __init__(self, accessor: MachineAccessor) -> None:
        self._accessor = accessor
        self._live: dict[str, list[str]] = {}
        self._latest: dict[str, tuple[int, str]] = {}
        self._landings = 0
        self._settling: dict[str, int] = {}
        self._unsettled: set[str] = set()
        self._removing: dict[str, asyncio.Event] = {}

    @asynccontextmanager
    async def landing(
        self, machine: str, path: PathSpec, *, replaces: bool
    ) -> AsyncIterator[None]:
        """Count a write of a name on a machine as live while it lands,
        and end it (``_end``).

        Args:
            machine (str): the machine written.
            path (PathSpec): the name.
            replaces (bool): the write replaces the name, so once it lands
                no other machine's copy of it stays.
        """
        slot = _removal_slot(path, machine)
        while (gone := self._removing.get(slot)) is not None:
            await gone.wait()
        self._live.setdefault(path.virtual, []).append(machine)
        try:
            yield
        except BaseException:
            await self._end(machine, path, landed=False, replaces=replaces)
            raise
        await self._end(machine, path, landed=True, replaces=replaces)

    async def _end(
        self, machine: str, path: PathSpec, *, landed: bool, replaces: bool
    ) -> None:
        """End a live write of a name. One that landed is the name's latest
        copy, noted while the name has other writes to settle with
        (``_latest``). One that replaces the name settles it, and so does
        the last write of an unsettled name to end.

        Args:
            machine (str): the machine written.
            path (PathSpec): the name.
            landed (bool): the write landed; a failed one leaves the
                copies of those that did.
            replaces (bool): the write replaces the name.
        """
        key = path.virtual
        live = self._live[key]
        live.remove(machine)
        if not live:
            del self._live[key]
        busy = bool(live) or key in self._unsettled or key in self._settling
        if landed and (replaces or busy):
            self._landings += 1
            self._latest[key] = (self._landings, machine)
        last_of_unsettled = not live and key in self._unsettled
        if not (landed and replaces) and not last_of_unsettled:
            self._forget(key)
            return
        if last_of_unsettled:
            self._unsettled.discard(key)
        try:
            await self._settle(path)
        except Exception as exc:
            if landed:
                raise
            logger.debug("older copies of %s kept: %s", key, exc)

    async def _settle(self, path: PathSpec) -> None:
        """Take a name off every machine but the one its latest write
        landed on (``_latest``), so one copy shows, the newest. The latest
        is looked up again before every removal, and a write landing
        meanwhile makes the look start over with its copy kept. A machine
        still writing the name keeps its copy and leaves the name
        unsettled, for the last write of it to settle (``_end``).

        Args:
            path (PathSpec): the name.
        """
        key = path.virtual
        self._settling[key] = self._settling.get(key, 0) + 1
        try:
            while self._accessor.several and (seen := self._latest.get(key)):
                for one in await place.holders(self._accessor, path):
                    if self._latest.get(key) != seen:
                        break
                    if one.machine == seen[1] or one.is_folder:
                        continue
                    if one.machine in self._live.get(key, ()):
                        self._unsettled.add(key)
                        continue
                    await self._remove_copy(one.machine, path)
                if self._latest.get(key) == seen:
                    return
        finally:
            self._settling[key] -= 1
            if not self._settling[key]:
                del self._settling[key]
            self._forget(key)

    async def _remove_copy(self, machine: str, path: PathSpec) -> None:
        """Take an older copy of a name off a machine, a write of the name
        there waiting until it is gone (``landing``); nothing when a
        removal of it is already under way, and a copy already gone is no
        error.

        Args:
            machine (str): the machine holding the copy.
            path (PathSpec): the name.
        """
        slot = _removal_slot(path, machine)
        if slot in self._removing:
            return
        gone = self._removing[slot] = asyncio.Event()
        try:
            await _unlink(self._accessor, machine, path)
        except FileNotFoundError as exc:
            logger.debug(
                "%s already gone from %s: %s", path.virtual, machine, exc
            )
        finally:
            del self._removing[slot]
            gone.set()

    def _forget(self, key: str) -> None:
        """Let go of a name's latest landing once nothing writes or settles
        it.

        Args:
            key (str): the name.
        """
        if (
            key not in self._live
            and key not in self._unsettled
            and key not in self._settling
        ):
            self._latest.pop(key, None)
