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

from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from typing import Any

from mirage.cache.lock import KeyHold
from mirage.io import OpReport
from mirage.io.stream import close_quietly, ensure_stream
from mirage.io.types import ByteSource
from mirage.types import VFSName


def _memory_answered(
    report: OpReport | None, moved: int | None = None
) -> None:
    """Stamp the caller's report: memory answered, no backend ran.

    Fires at the moment a warm file-cache hit or a synthetic namespace
    answer is in hand, before the post gate and any output cap, so
    whatever those raise cannot erase the fact. The value is
    ``VFSName.RAM``, which is how a record says "this never
    crossed the network": ``OpRecord.is_cache`` is defined as that
    string, and every network/cache total derives from it.

    Args:
        report (OpReport | None): the caller's report, None when the
            caller does not observe ops.
        moved (int | None): bytes memory served, None when the result
            is the measure.
    """
    if report is not None:
        report.served(VFSName.RAM.value, moved)


def _served(
    report: OpReport | None, result: Any, moved: int | None = None
) -> None:
    """Stamp the caller's report: the owning mount answered. A report
    already stamped (a serial write's, under its hold) keeps that.

    Args:
        report (OpReport | None): the caller's report, None when the
            caller does not observe ops.
        result (Any): the op's answer; bytes are the measure moved.
        moved (int | None): bytes a streamed write sent, which neither
            its answer nor its arguments measure.
    """
    if report is not None and not report.completed:
        if moved is None and isinstance(result, (bytes, bytearray)):
            moved = len(result)
        report.served(None, moved)


async def _primed(
    stream: AsyncIterator[bytes], report: OpReport | None, pull: bool = True
) -> AsyncIterator[bytes]:
    """Pull a stream's first chunk now and answer the stream from there.

    A read that fails at its start (a missing file, a refused request)
    then fails at the call, where the dispatcher handles it, rather than in
    the hands of whoever pulls the stream later. A live pipe's first byte
    may wait on the very reader about to ask for it, so its read is framed
    unpulled.

    Args:
        stream (AsyncIterator[bytes]): the streamed read.
        report (OpReport | None): the caller's report.
        pull (bool): pull the first chunk now; False for a live pipe.
    """
    iterator = stream.__aiter__()
    head: list[bytes] = []
    if pull:
        try:
            head = [await iterator.__anext__()]
        except StopAsyncIteration:
            head = []
        except BaseException:
            await close_quietly(iterator)
            raise
    resumed = _resumed(head, iterator, report)
    await resumed.__anext__()
    return resumed


async def _resumed(
    head: list[bytes],
    iterator: AsyncIterator[bytes],
    report: OpReport | None,
) -> AsyncIterator[bytes]:
    """The chunks already pulled, then the rest of the stream.

    ``_primed`` runs it to its empty first step, inside the ``try``, so a
    caller that closes it before pulling still closes the stream. The
    stream completes when its last chunk is pulled or it is closed, so
    that is when the caller's report is stamped, with the bytes the
    store moved.

    Args:
        head (list[bytes]): what was pulled before the caller asked.
        iterator (AsyncIterator[bytes]): the stream after them.
        report (OpReport | None): the caller's report.
    """
    moved = sum(len(chunk) for chunk in head)
    try:
        yield b""
        for chunk in head:
            yield chunk
        async for chunk in iterator:
            moved += len(chunk)
            yield chunk
    finally:
        await close_quietly(iterator)
        if report is not None:
            report.served(None, moved)


class _LentPayload:
    """A streamed write's bytes, pulled with its names let go.

    The producer may wait on another writer of the same name (``tee -a f
    | tee -a f``, a loop appending to the file it pipes into), so the
    write holds the name only while the store takes a chunk, and writers
    interleave between chunks as two descriptors of one file do: a
    replacement landing there leaves the stream's later chunks at its own
    offset, as Linux does. What the store took is kept while it fits the
    cache's drain budget, so the next read is served what was written, as
    a whole write's is.

    Args:
        source (ByteSource): the producer's bytes.
        holds (list[KeyHold]): the write's names, held.
        budget (int): the most bytes kept for the cache.
    """

    def __init__(
        self, source: ByteSource, holds: list[KeyHold], budget: int
    ) -> None:
        self.source = ensure_stream(source)
        self.holds = holds
        self.budget = budget
        self.moved = 0
        self.kept: list[bytes] | None = []

    def whole(self) -> bytes | None:
        return None if self.kept is None else b"".join(self.kept)

    async def chunks(self) -> AsyncIterator[bytes]:
        try:
            while True:
                async with AsyncExitStack() as lent:
                    for hold in reversed(self.holds):
                        await lent.enter_async_context(hold.released())
                    chunk = await anext(self.source, None)
                if chunk is None:
                    return
                self.moved += len(chunk)
                if self.kept is not None and self.moved > self.budget:
                    self.kept = None
                if self.kept is not None:
                    self.kept.append(chunk)
                yield chunk
        finally:
            await close_quietly(self.source)
