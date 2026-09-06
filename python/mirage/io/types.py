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
from dataclasses import dataclass

from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.cooperative import chunks
from mirage.types import Producer, Refusal

ByteSource = bytes | AsyncIterator[bytes]

# The shape every command returns: a live stdout stream (None when
# buffered into the result) and the command's outcome.
CommandOutput = tuple["ByteSource | None", "IOResult"]


async def materialize(stream: ByteSource | None) -> bytes:
    """Consume a ByteSource and return bytes."""
    if stream is None:
        return b""
    if isinstance(stream, bytes):
        return stream
    if isinstance(stream, CachableAsyncIterator):
        return await stream.drain()
    return b"".join([chunk async for chunk in chunks(stream)])


@dataclass
class OpReport:
    """The op door's account of what actually ran, filled in place.

    A caller that observes ops passes one per dispatch and reads it
    back whatever happens next: the door stamps it the moment an op
    completes, before invalidation, the post gate, or an output cap
    run, so a failure in any of those cannot erase the fact that the
    backend already did the work. Riding the result loses that fact on
    every error, and riding the exception only covers exceptions the
    door itself defines; a report object covers a foreign error (a
    cache-store outage, an invalid policy return) the same way.

    Args:
        completed (bool): the op ran against its answering store. False
            until the door says otherwise, so a refusal at a pre gate
            or a backend failure leaves nothing to record.
        source (str | None): who answered, when that was not the owning
            mount: "ram" for a warm file-cache hit and for a synthetic
            namespace answer, since neither contacted a backend. None
            means the owning mount answered.
        bytes (int | None): bytes the answering store moved, when the
            delivered result no longer measures them. None means "the
            result is the measure".
    """

    completed: bool = False
    source: str | None = None
    bytes: int | None = None

    def served(self,
               source: str | None = None,
               moved: int | None = None) -> None:
        """Stamp the report at the moment an op completes.

        Args:
            source (str | None): who answered, None for the owning
                mount.
            moved (int | None): bytes the answering store moved, None
                when the result is the measure.
        """
        self.completed = True
        self.source = source
        self.bytes = moved


class IOResult:
    """Returned by commands to tell workspace how to update cache.

    ``exit_code`` is a delegating read, not a plain field, because a
    streaming command's status can depend on its content: grep returns
    ``(exit_on_empty(stream, io_A), io_A)`` with a provisional
    ``io_A.exit_code = 0``, and the wrapper settles the real value on
    ``io_A`` only when the stream is drained. ``merge()`` therefore
    links the merged result to its right-hand original instead of
    copying the number, and a read follows the link, so the value is
    exactly as fresh as the origin at the moment it is read, however
    many merges sit in between and however early or often it is read.
    An explicit write (``io.exit_code = 124``) stores locally and
    severs the link, so an aggregated or overridden status always
    wins over the lazy one (issue #43). The one rule left for callers
    is the one the shell's barriers already enforce: drain the stream
    before treating the status as final.

    Args:
        stdout (ByteSource | None): Standard output stream.
        stderr (ByteSource | None): Standard error stream.
        exit_code (int): Process exit code.
        reads (dict[str, ByteSource] | None): Paths read with content
            or streams.
        writes (dict[str, ByteSource] | None): Paths written with
            content or streams.
        cache (list[str] | None): Paths worth caching (from reads or
            writes).
        producer (Producer | None): provenance of this result (which
            command, spanning which mounts); merge keeps the rightmost
            producer, mirroring whose stream the shell shows. The
            workspace boundary hands it to the policy layer as
            context. Facts ride the envelope as policy input; the
            decision a chain hands down rides beside them as
            ``refusal``, written after the last hook has spoken.
        mutated (bool | None): whether this run changed service state,
            when only the handler can tell. A CLI leaf declares
            ``write`` statically because for almost every verb it is
            static, but ``gh api`` carries its method on the line, so a
            plain ``gh api /user`` is a read through a leaf that is
            declared writable. None leaves the spec's answer standing.
        refusal (Refusal | None): why the line did not run, when a
            policy or an unanswered ask refused it; None on every
            ordinary run. stderr stays in bash's voice, this carries
            the reason. merge keeps the rightmost record, as it does
            the producer.
    """

    def __init__(self,
                 stdout: ByteSource | None = None,
                 stderr: ByteSource | None = None,
                 exit_code: int = 0,
                 reads: dict[str, ByteSource] | None = None,
                 writes: dict[str, ByteSource] | None = None,
                 cache: list[str] | None = None,
                 producer: Producer | None = None,
                 mutated: bool | None = None,
                 refusal: Refusal | None = None) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self._exit_code = exit_code
        self.reads: dict[str, ByteSource] = reads if reads is not None else {}
        self.writes: dict[str,
                          ByteSource] = writes if writes is not None else {}
        self.cache: list[str] = cache if cache is not None else []
        self.producer = producer
        self.mutated = mutated
        self.refusal = refusal
        self._stream_source: IOResult | None = None

    @property
    def exit_code(self) -> int:
        if self._stream_source is not None:
            return self._stream_source.exit_code
        return self._exit_code

    @exit_code.setter
    def exit_code(self, value: int) -> None:
        self._exit_code = value
        self._stream_source = None

    async def materialize_stdout(self) -> bytes:
        self.stdout = await materialize(self.stdout)
        return self.stdout

    async def stdout_str(self, errors: str = "replace") -> str:
        return (await self.materialize_stdout()).decode(errors=errors)

    async def materialize_stderr(self) -> bytes:
        self.stderr = await materialize(self.stderr)
        return self.stderr

    async def stderr_str(self, errors: str = "replace") -> str:
        return (await self.materialize_stderr()).decode(errors=errors)

    async def merge(self, other: "IOResult") -> "IOResult":
        # Fully consume stderr from both sides so it's never lost.
        left_stderr = await materialize(self.stderr)
        right_stderr = await materialize(other.stderr)
        merged_stderr: bytes | None = None
        if left_stderr or right_stderr:
            merged_stderr = left_stderr + right_stderr
        # The exit code is not copied: the merged result reads it
        # through the link, so a lazy status settling after this merge
        # (exit_on_empty firing at drain time) is still visible.
        result = IOResult(
            stdout=other.stdout,
            stderr=merged_stderr,
            reads={
                **self.reads,
                **other.reads
            },
            writes={
                **self.writes,
                **other.writes
            },
            cache=self.cache + other.cache,
            producer=other.producer,
            refusal=(other.refusal
                     if other.refusal is not None else self.refusal),
        )
        result._stream_source = other
        return result
