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
import errno
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from contextvars import ContextVar
from dataclasses import dataclass, field

from mirage.io.async_line_iterator import SharedInput
from mirage.shell.console import Channel, JobConsole, OwnedStream, Terminal
from mirage.shell.constants import FD_BOTH, FD_CLOSE
from mirage.shell.types import Redirect, RedirectKind
from mirage.types import PathSpec
from mirage.utils.errors import BadDescriptorError


def unsupported_descriptor(redirects: Iterable[Redirect]) -> int | None:
    """The first descriptor outside the signed 32-bit range, or None.

    Both slots count: the descriptor a redirect claims (`3>f`, `3<f`,
    `3>&1`, `3>&-`) and the one it duplicates from (`>&3`, `<&3`,
    `2>&3`). `&>`'s FD_BOTH and `>&-`'s FD_CLOSE are the two sentinels
    the parser spells with -1, and neither is a descriptor.

    An ambiguous redirect (``3>&word``) is skipped: bash refuses it in
    its own words before it judges the descriptor, and so does the
    installer.

    Args:
        redirects (Iterable[Redirect]): parsed redirects, in line order.
    """
    for r in redirects:
        if r.kind == RedirectKind.AMBIGUOUS:
            continue
        if not 0 <= r.fd < 2**31 and r.fd != FD_BOTH:
            return r.fd
        if (
            isinstance(r.target, int)
            and not 0 <= r.target < 2**31
            and r.target != FD_CLOSE
        ):
            return r.target
    return None


def bad_descriptor_line(fd: int) -> bytes:
    """Bash's error for a closed descriptor, without the line-number prefix.

    Args:
        fd (int): the descriptor that was named.
    """
    return f"{fd}: Bad file descriptor\n".encode()


async def unreadable_stdin() -> AsyncIterator[bytes]:
    """Standard input that fails on its first read with EBADF.

    bash opens a command whose stdin is closed (``<&-``) or duplicated
    from a write-only descriptor (``0<&1``) all the same; the descriptor
    exists, and only a read of it fails. A command that never reads
    (``true 0<&1``) succeeds, and one that does reports
    ``<cmd>: -: Bad file descriptor`` and exits 1, which is what the
    chokepoint renders from the error this raises.
    """
    raise BadDescriptorError(errno.EBADF, "Bad file descriptor", "-")
    yield b""  # pragma: no cover - makes this an async generator


class FileInput(SharedInput):
    def __init__(self, description: "FileDescription", data: bytes) -> None:
        super().__init__(data)
        self.description = description

    def dup(self) -> "FileInput":
        return self


@dataclass
class FileDescription:
    scope: PathSpec
    append: bool = False
    opened: bool = False
    offset: int = 0
    source: FileInput | None = None
    emit: Callable[[bytes], Awaitable[None]] | None = None
    writing: asyncio.Lock = field(
        default_factory=asyncio.Lock, compare=False, repr=False
    )


class StreamOwner:
    """Who a stream a level was given belongs to: a redirect level's
    recorder, or a session, whose own line its terminal streams are."""


@dataclass(frozen=True, eq=False)
class Inherited:
    """The stdout or stderr a level was given rather than opened.

    A descriptor copied from it (``3>&1``, ``exec 3>&1``) keeps naming it
    after the level rebinds its own (``3>&1 >f``), as bash's copy keeps
    the open file description.
    """

    owner: StreamOwner
    channel: Channel


class Recorder(JobConsole, StreamOwner):
    """What one level's command wrote, in order, for the level to route.

    A chunk on a channel goes through the level's descriptor table; one
    written to a stream another level owns stays in place on its way up
    to that level, so it lands among the bytes written around it.
    """

    def __init__(self) -> None:
        super().__init__()
        self.chunks: list[tuple[Channel | Inherited, bytes]] = []

    async def emit(self, channel: Channel, data: bytes) -> None:
        self.chunks.append((channel, data))

    async def emit_to(self, stream: OwnedStream, data: bytes) -> None:
        if isinstance(stream, Inherited):
            self.chunks.append((stream, data))
        else:
            await self.emit(stream.channel, data)


# The recorder of the innermost level running a command, for a level
# whose output is a value (a substitution's) to send another level's
# stream bytes toward it.
ENCLOSING: ContextVar[Recorder | None] = ContextVar(
    "enclosing_recorder", default=None
)


async def deliver(
    sink: JobConsole | None, stream: Inherited, data: bytes
) -> bool:
    """Send bytes written to a stream another level owns toward it.

    They go up through the sink, or the enclosing level's recorder when
    the level returns its output as a value or writes to a terminal of
    its own (a line's, a substitution's), which owns no stream above
    it. A console that keeps no streams takes them on their channel.
    False when there is nowhere above.

    Args:
        sink (JobConsole | None): where the level writes.
        stream (Inherited): the stream the bytes were written to.
        data (bytes): the bytes.
    """
    target = (
        sink
        if sink is not None and not isinstance(sink, Terminal)
        else ENCLOSING.get()
    )
    if target is None:
        return False
    await target.emit_to(stream, data)
    return True


@dataclass(frozen=True)
class Descriptor:
    identity: str
    append: bool = False
    source: SharedInput | None = None
    file: FileDescription | None = None
    stream: Inherited | None = None
