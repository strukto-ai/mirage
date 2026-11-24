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
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from functools import partial

from mirage.accessor.machine import MachineAccessor
from mirage.core.machine import place
from mirage.core.machine.types import Landing
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


async def _unlink_older(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> None:
    """Take an older copy of a name off a machine; one already gone is no
    error.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine holding the copy.
        path (PathSpec): the name.
    """
    try:
        await _unlink(accessor, machine, path)
    except FileNotFoundError as exc:
        logger.debug("%s already gone from %s: %s", path.virtual, machine, exc)


class LiveWrites:
    """The writes landing on a machine mount's names, kept so that once
    the writes of a name end, one copy of it shows, the newest. A write
    is live from before it chooses its machine until it ends
    (``landing``). One that replaces a name settles it: every other
    machine's copy goes (``_settle``). A write live meanwhile leaves the
    name unsettled, and the last write of the name to end settles it
    again, a failed one too. No copy goes while a write still chooses
    its machine, nor the copy of a machine a live write chose, and a
    write whose machine's copy is being removed chooses again, so a
    write never builds on a copy that is going.

    Args:
        accessor (MachineAccessor): the mount's machines.
    """

    def __init__(self, accessor: MachineAccessor) -> None:
        self._accessor = accessor
        self._live: dict[str, list[str | None]] = {}
        self._latest: dict[str, tuple[int, str]] = {}
        self._landings = 0
        self._settling: dict[str, int] = {}
        self._unsettled: set[str] = set()
        self._removing: dict[str, asyncio.Task[None]] = {}

    @asynccontextmanager
    async def landing(
        self, path: PathSpec, choose: Callable[[], Awaitable[Landing]]
    ) -> AsyncIterator[Landing]:
        """Count a write of a name as live from before it chooses its
        machine until it ends (``_end``). While it chooses, a settling
        takes no copy of the name away, since the write may land on any,
        and leaves the name for the write to settle; a write that begins
        while the name settles leaves it unsettled at once. A write whose
        machine's copy is being removed waits for the removal and chooses
        again, so it neither builds on a copy that is going nor has the
        removal take its bytes.

        Args:
            path (PathSpec): the name.
            choose (Callable[[], Awaitable[Landing]]): where the write
                lands; one whose bytes come from that machine
                (``Landing.origin``) replaces the name, so once it lands
                no other machine's copy of it stays.
        """
        key = path.virtual
        live = self._live.setdefault(key, [])
        live.append(None)
        if key in self._settling:
            self._unsettled.add(key)
        machine: str | None = None
        try:
            landing = await choose()
            while (
                removal := self._removing.get(
                    _removal_slot(path, landing.machine)
                )
            ) is not None:
                await asyncio.wait({removal})
                landing = await choose()
            machine = landing.machine
            live[live.index(None)] = machine
            yield landing
        except BaseException:
            await self._end(machine, path, landed=False, replaces=False)
            raise
        await self._end(machine, path, landed=True, replaces=landing.origin)

    async def _end(
        self,
        machine: str | None,
        path: PathSpec,
        *,
        landed: bool,
        replaces: bool,
    ) -> None:
        """End a live write of a name. One that landed is the name's latest
        copy, noted while the name has other writes to settle with
        (``_latest``). One that replaces the name settles it, and so does
        the last write of an unsettled name to end.

        Args:
            machine (str | None): the machine written; None for a write
                that ended before choosing one.
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
        if landed and machine is not None and (replaces or busy):
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
        meanwhile makes the look start over with its copy kept. A write
        live as the look starts, on another machine or still choosing one,
        leaves the name unsettled, as one beginning meanwhile does
        (``landing``), for the last write of it to settle (``_end``). A
        machine a live write chose keeps its copy, found or not yet made,
        and no copy goes while a write still chooses its machine.

        Args:
            path (PathSpec): the name.
        """
        key = path.virtual
        self._settling[key] = self._settling.get(key, 0) + 1
        try:
            while self._accessor.several and (seen := self._latest.get(key)):
                if any(m != seen[1] for m in self._live.get(key, ())):
                    self._unsettled.add(key)
                for one in await place.holders(self._accessor, path):
                    if self._latest.get(key) != seen:
                        break
                    live = self._live.get(key, ())
                    if (
                        one.machine == seen[1]
                        or one.is_folder
                        or one.machine in live
                        or None in live
                    ):
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
        """Take an older copy of a name off a machine, once: a settling
        that finds the removal under way waits for it and shares its
        outcome, a failure too, and a write of the name there waits until
        it is gone (``landing``).

        Args:
            machine (str): the machine holding the copy.
            path (PathSpec): the name.
        """
        slot = _removal_slot(path, machine)
        removal = self._removing.get(slot)
        if removal is None:
            removal = asyncio.ensure_future(
                _unlink_older(self._accessor, machine, path)
            )
            self._removing[slot] = removal
            removal.add_done_callback(partial(self._removed, slot))
        await asyncio.shield(removal)

    def _removed(self, slot: str, removal: asyncio.Task[None]) -> None:
        """Let go of a finished removal, logging a failure no settling
        waits on any more.

        Args:
            slot (str): the removal's key (``_removal_slot``).
            removal (asyncio.Task[None]): the removal.
        """
        if self._removing.get(slot) is removal:
            del self._removing[slot]
        if (
            not removal.cancelled()
            and (exc := removal.exception()) is not None
        ):
            logger.debug("removing an older copy failed: %s", exc)

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
