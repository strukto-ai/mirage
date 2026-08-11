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

from typing import Protocol

from mirage.shell.console.config import Channel, ConsoleChunk

ReadResult = tuple[list[ConsoleChunk], int, bool]


class ConsoleStore(Protocol):
    """Storage for one job's console.

    The role this contract fills is a stream: ordered append, read from a
    position, and block until there is more. RAM satisfies it with a list,
    Redis Streams with XADD/XRANGE/XREAD BLOCK. A home qualifies by
    offering those primitives, never by brand.

    The store knows nothing about jobs ending. Termination is an ordinary
    CONTROL chunk, so a blocked reader is woken by it like any other
    append, and every home can express it.
    """

    async def append(self, channel: Channel, data: bytes) -> ConsoleChunk:
        """Add a chunk and return it with its assigned seq.

        Args:
            channel (Channel): which stream the bytes came from.
            data (bytes): the payload.
        """
        ...

    async def read_from(self,
                        seq: int,
                        limit: int | None = None) -> ReadResult:
        """Read chunks at or after a cursor.

        Returns the chunks, the cursor to pass next time, and whether the
        requested cursor had already been dropped by retention. A reader
        that fell behind resumes at the oldest retained chunk and is told
        so, rather than silently losing bytes.

        Args:
            seq (int): cursor to read from.
            limit (int | None): most chunks to return, or None for all.
        """
        ...

    @property
    def closed(self) -> bool:
        """Whether ``close`` has run.

        Readers loop, so waking them once is not enough to end a follow:
        they re-read, find no CONTROL chunk, and wait again. They check
        this to tell "more may arrive" from "this console is discarded".
        """
        ...

    async def wait(self, seq: int) -> None:
        """Return once the console holds a chunk after ``seq``.

        Returns immediately on a closed store, which is what keeps a
        reader that re-arms from parking on a console nobody will write
        to again.

        Args:
            seq (int): cursor the caller has already consumed up to.
        """
        ...

    async def close(self) -> None:
        """Release the store's resources.

        This is not "the job ended": that is the CONTROL chunk. Closing
        wakes any blocked reader so nothing hangs on a discarded console.
        """
        ...
