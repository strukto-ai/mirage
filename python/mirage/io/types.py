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

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal

from mirage.io.cooperative import chunks
from mirage.types import PathSpec, Producer, Refusal

ByteSource = bytes | AsyncIterator[bytes]
StreamName = Literal["stdout", "stderr"]


@dataclass(frozen=True, slots=True)
class OutputEvent:
    stream: StreamName
    data: bytes


class DeviceInput(bytes):
    """Standard input redirected from a character device (``< /dev/null``).

    It reads as the bytes it holds, like any other stdin, and tells a
    command that asks whether a file, FIFO or socket is attached that none
    is: ripgrep asks before it searches stdin rather than the working
    directory (grep_cli::is_readable_stdin).
    """


# The shape every command returns: a live stdout stream (None when
# buffered into the result) and the command's outcome.
CommandOutput = tuple["ByteSource | None", "IOResult"]


@dataclass(slots=True)
class OutputState:
    """Routing and settlement shared by a live handler's result and drain."""

    stderr: Callable[[bytes], Awaitable[None]] | None = None
    settled: bool = False
    callbacks: list[Callable[[], None]] = field(default_factory=list)

    def finish(self) -> None:
        self.settled = True
        for callback in self.callbacks:
            callback()
        self.callbacks.clear()


async def materialize(stream: ByteSource | None) -> bytes:
    """Consume a ByteSource and return bytes."""
    if stream is None:
        return b""
    if isinstance(stream, bytes):
        return stream
    return b"".join([chunk async for chunk in chunks(stream)])


@dataclass(frozen=True, slots=True)
class SizedRun:
    """One ``du`` operand as measured, before its rows are rendered.

    du derives every row from the files it counted, so a line spanning
    mounts renders each mount's own measurement as one tree, the way
    find's actions run over every mount's ``matched_runs``.

    Args:
        leaves (tuple[tuple[str, int], ...]): every file counted, as
            (virtual path, bytes).
        directories (tuple[str, ...]): directories the walk met, which
            keep a row though no counted file lies under them.
    """

    leaves: tuple[tuple[str, int], ...] = ()
    directories: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CountedRun:
    """One ``wc`` operand as counted, before its row is rendered.

    A line spanning mounts lays every mount's own counts out as one
    report, with one column width and one total, the way du renders
    every mount's ``sized_runs`` as one tree.

    Args:
        values (tuple[int, ...]): the counts the row shows, in GNU's
            column order.
        label (str | None): the name the row prints, None for none.
    """

    values: tuple[int, ...] = ()
    label: str | None = None


@dataclass
class OpReport:
    """The dispatcher's account of what actually ran, filled in place.

    A caller that observes ops passes one per dispatch and reads it
    back whatever happens next: the dispatcher stamps it the moment an op
    completes, before invalidation, the post gate, or an output cap
    run, so a failure in any of those cannot erase the fact that the
    backend already did the work. Riding the result loses that fact on
    every error, and riding the exception only covers exceptions the
    dispatcher itself defines; a report object covers a foreign error (a
    cache-store outage, an invalid policy return) the same way.

    Args:
        completed (bool): the op ran against its answering store. False
            until the dispatcher says otherwise, so a refusal at a pre gate
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

    def served(
        self, source: str | None = None, moved: int | None = None
    ) -> None:
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
    """What a command returns beside its output: its status, its stderr
    and the facts it reports for later actions.

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
        matched_runs (list[list[PathSpec]] | None): Structured selection
            before display rendering, for commands whose matches feed
            later actions: one list of rows per start point, in operand
            order, so a nested or repeated start point stays its own
            traversal (GNU walks each to completion before the next).
            None means the command supplied no structured selection.
        sized_runs (list[SizedRun] | None): ``du``'s measurement before
            rendering, one run per operand it could read, in operand
            order. None means the command supplied none.
        counted_runs (list[CountedRun] | None): ``wc``'s counts before
            rendering, one run per row it prints, in operand order and
            without the total. None means the command supplied none.
        stdout (ByteSource | None): Standard output stream.
        stderr (ByteSource | None): Standard error stream.
        exit_code (int): Process exit code.
        producer (Producer | None): provenance of this result (which
            command, spanning which mounts); merge keeps the rightmost
            producer, for attribution, not ownership of aggregate output. The
            workspace boundary hands it to the policy layer as
            context. Facts ride the envelope as policy input; the
            decision a chain hands down rides beside them as
            ``refusal``, written after the last hook has spoken.
        refusal (Refusal | None): why the line did not run, when a
            policy or an unanswered ask refused it; None on every
            ordinary run. stderr stays in bash's voice, this carries
            the reason. merge keeps the rightmost record, as it does
            the producer.
    """

    def __init__(
        self,
        stdout: ByteSource | None = None,
        stderr: ByteSource | None = None,
        exit_code: int = 0,
        producer: Producer | None = None,
        refusal: Refusal | None = None,
        matched_runs: list[list[PathSpec]] | None = None,
        sized_runs: list[SizedRun] | None = None,
        counted_runs: list[CountedRun] | None = None,
    ) -> None:
        self.stdout = stdout
        self.matched_runs = matched_runs
        self.sized_runs = sized_runs
        self.counted_runs = counted_runs
        self.stderr = stderr
        self._exit_code = exit_code
        self.output: OutputState | None = None
        self.output_finalized = False
        self.producer = producer
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
            matched_runs=other.matched_runs,
            sized_runs=other.sized_runs,
            counted_runs=other.counted_runs,
            stderr=merged_stderr,
            producer=other.producer,
            refusal=(
                other.refusal if other.refusal is not None else self.refusal
            ),
        )
        result.output = other.output
        result.output_finalized = other.output_finalized
        result._stream_source = other
        return result


HandlerResult = CommandOutput | IOResult | None
