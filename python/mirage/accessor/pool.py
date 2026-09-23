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
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger(__name__)

ClientManager = AbstractAsyncContextManager[Any]
ClientFactory = Callable[[], ClientManager]


@dataclass(slots=True)
class _Entry:
    """One open client and the context manager that releases it.

    The context manager itself, not an AsyncExitStack wrapping it: a stack
    pops each callback BEFORE invoking it, so once an exit raises or is
    cancelled that callback is gone and a later attempt silently does
    nothing. Holding the manager means `__aexit__` can actually be called
    again, which is what makes a failed release retryable rather than merely
    remembered.

    Args:
        client (Any): the open client.
        manager (ClientManager): releases the client on exit.
    """
    client: Any
    manager: ClientManager


class LoopClientCache:
    """One open client per event loop, opened once and released exactly once.

    A client that costs real time to build is worth keeping, but keeping it
    turns its lifetime into this object's problem: whatever used to close at
    the end of every operation no longer does. The whole point of this class
    is that "opened" and "released" cannot drift apart, so every way they can
    is answered structurally here rather than left to each call site:

    - opening is serialized per loop, so two callers that both miss cannot
      each open a client and have one of them go untracked;
    - releasing takes ownership of its entry, so of two callers releasing the
      same client exactly one runs `__aexit__`, and the entry is put back if
      that exit does not complete;
    - a loop that closed leaves nothing behind, whether or not it ever got as
      far as an open client;
    - `close` reports a failure rather than logging it, so a caller that
      records "closed" only records it when everything really is.

    Clients bind to the loop that opened them, so the key is the loop OBJECT.
    Never `id(loop)`: CPython reuses the address of a collected loop, so a
    second `asyncio.run()` can hash to a client belonging to the first run's
    closed loop.
    """

    def __init__(self, what: str) -> None:
        """Build an empty cache.

        Args:
            what (str): what is being cached, for log lines ("s3").
        """
        self.what = what
        self._entries: dict[asyncio.AbstractEventLoop, _Entry] = {}
        self._locks: dict[asyncio.AbstractEventLoop, asyncio.Lock] = {}

    async def get(self, factory: ClientFactory) -> Any:
        """Return this loop's client, opening one when there is none.

        Args:
            factory (ClientFactory): builds the client manager. Called
                only on a miss, so a hit costs one dict lookup.

        Returns:
            Any: the open client for the running loop.
        """
        loop = asyncio.get_running_loop()
        await self.release_dead()
        entry = self._entries.get(loop)
        if entry is not None:
            return entry.client
        # `factory()` may suspend (resolving credentials can reach IMDS or
        # SSO), so without this two callers that both miss would each open a
        # client and the loser's manager would never be reachable again.
        # setdefault is atomic because nothing awaits between the read and the
        # write, so both callers take the same lock.
        lock = self._locks.setdefault(loop, asyncio.Lock())
        async with lock:
            entry = self._entries.get(loop)
            if entry is not None:
                return entry.client
            manager = factory()
            client = await manager.__aenter__()
            self._entries[loop] = _Entry(client=client, manager=manager)
            return client

    async def _release(self, loop: asyncio.AbstractEventLoop) -> None:
        """Release one entry, keeping it if its exit does not finish.

        Args:
            loop (asyncio.AbstractEventLoop): the loop whose client to close.
        """
        # Popping FIRST is what makes a release exclusive. Nothing awaits
        # between the lookup and the pop, so of two callers sweeping the same
        # dead loop one holds the entry and the other finds nothing, instead
        # of both running `__aexit__` on one client. Putting it back on the
        # way out is what keeps that safe: an exit that raises or is
        # cancelled leaves the entry retryable rather than unreachable.
        entry = self._entries.pop(loop, None)
        if entry is None:
            return
        try:
            await entry.manager.__aexit__(None, None, None)
        except BaseException:
            self._entries[loop] = entry
            raise

    def _drop_dead_locks(self) -> None:
        """Forget the locks belonging to loops that have gone.

        Swept by liveness rather than at each site that could strand one: a
        loop whose `__aenter__` raised holds a lock and no entry, so a sweep
        that only visited entries would pin every such loop object forever.
        """
        for loop in [one for one in self._locks if one.is_closed()]:
            self._locks.pop(loop, None)

    async def release_dead(self) -> None:
        """Close the clients whose loop has gone.

        A closing loop does not run the client's context manager, so an entry
        left behind is an abandoned connection pool. Exiting the manager from
        a later loop does work, so close it rather than forgetting it.
        """
        for loop in [one for one in self._entries if one.is_closed()]:
            try:
                await self._release(loop)
            except Exception as exc:
                # Logged rather than raised, and only here: this runs on the
                # read path, where a stale client that will not close is no
                # reason to fail the unrelated operation that noticed it. The
                # entry stays, and `close` is where a failure is reported.
                logger.debug(
                    "%s: releasing a dead loop's client failed, "
                    "will retry: %s", self.what, exc)
        self._drop_dead_locks()

    async def close(self) -> None:
        """Close every client this cache opened, reporting any failure.

        Every loop is attempted before anything is raised, so one failure
        cannot skip the rest, and the entry that failed stays for a later
        attempt. The failure is then raised rather than logged, because a
        caller that swallows it goes on to record itself as closed (see
        `VFS.close`), and a closed VFS returns early the next time,
        so nothing could ever reach the retained entry again.

        Raises:
            Exception: the first release failure, once all were attempted.
        """
        failures: list[Exception] = []
        for loop in list(self._entries):
            try:
                await self._release(loop)
            except Exception as exc:
                failures.append(exc)
        self._drop_dead_locks()
        for extra in failures[1:]:
            logger.debug("%s: releasing a client also failed: %s", self.what,
                         extra)
        if failures:
            raise failures[0]
