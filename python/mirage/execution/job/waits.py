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
from collections.abc import Awaitable, Callable

from mirage.shell.console import Channel, JobConsole, JobOutput, OwnedStream


class Hold:
    """What a child holds open of a capture: what its descriptors that
    lead into the capture named as it started (``&1``, ``&2``, a copy),
    until its shell points every descriptor elsewhere (``exec
    2>/dev/null``), as bash's capture ends once each writer has closed
    the pipe.

    Args:
        named (frozenset[str]): what those descriptors named.
    """

    def __init__(self, named: frozenset[str]) -> None:
        self.named = named
        self.released = asyncio.Event()

    def settle(self, named: set[str]) -> None:
        """Let go of the capture once none of the shell's descriptors
        names what led into it.

        Args:
            named (set[str]): what the shell's descriptors name now.
        """
        if self.named.isdisjoint(named):
            self.released.set()


class JobWaits:
    """The background jobs and process substitutions started inside a
    capture (``$( )``, a pipe stage), which the capture waits for before
    it ends: bash reads the pipe until every writer has closed it, and a
    child holds it open for as long as one of its streams leads into it.

    Args:
        output (JobOutput): where the capture's jobs write, at its edge.
        channels (frozenset[Channel]): what the capture reads there:
            stdout, and stderr too for a stage piped with ``|&``.
    """

    def __init__(
        self,
        output: JobOutput,
        channels: frozenset[Channel] = frozenset({Channel.STDOUT}),
    ) -> None:
        self.ends: list[Callable[[], Awaitable[None]]] = []
        self.output = output
        self.channels = channels

    def reaches(
        self, start: JobConsole, streams: set[Channel | OwnedStream]
    ) -> bool:
        """Whether a job writing ``streams`` where ``start`` leads writes
        into the capture.

        A redirect on the way (``JobRoute``) may send them elsewhere; a
        stream that no level on the way owns is counted, as it may be the
        capture's.

        Args:
            start (JobConsole): where the job's shell writes.
            streams (set[Channel | OwnedStream]): what the job writes.
        """
        at = start
        left = set(streams)
        while at is not self.output:
            if not isinstance(at, JobOutput):
                return True
            left = at.passes(left)
            at = at.target
        return any(
            not isinstance(stream, Channel) or stream in self.channels
            for stream in left
        )

    def add(
        self, ended: Callable[[], Awaitable[None]], named: frozenset[str]
    ) -> Hold:
        """Count a child the capture has to outlast, until it ends or
        lets go of the capture (``Hold``).

        Args:
            ended (Callable[[], Awaitable[None]]): returns once the child
                has ended.
            named (frozenset[str]): what the child's descriptors that lead
                into the capture named as it started.
        """
        hold = Hold(named)

        async def held() -> None:
            waiting = (
                asyncio.ensure_future(ended()),
                asyncio.ensure_future(hold.released.wait()),
            )
            try:
                await asyncio.wait(
                    waiting, return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                for waiter in waiting:
                    waiter.cancel()

        self.ends.append(held)
        return hold

    async def join(self, rest: JobConsole) -> None:
        """Return once every child writing into the capture has ended;
        what the capture's other children write from then on goes to
        ``rest``, where the capture's caller writes.

        Args:
            rest (JobConsole): where the capture's caller writes.
        """
        # A child added while this waits is still reached: the loop reads
        # the list as it grows.
        for ended in self.ends:
            await ended()
        self.output.target = rest
