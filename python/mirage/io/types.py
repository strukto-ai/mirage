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

from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Sequence,
)
from dataclasses import dataclass, field
from typing import Any, Generic, Literal, Protocol, TypeVar

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


class PipeEnd(Protocol):
    """The live pipe a ``PipeStream`` reads, for a descriptor reading on
    after it."""

    def stream(self, path: PathSpec) -> AsyncGenerator[bytes, None]: ...


@dataclass(frozen=True, slots=True)
class ClosedPipe:
    """How a writer answers its stdout's reader going away instead of
    dying of SIGPIPE (``tee -p``).

    Args:
        stderr (bytes): what it says about it.
        exit_code (int | None): the status it ends with, None to keep its
            own.
    """

    stderr: bytes = b""
    exit_code: int | None = None


class PipeStream(AsyncIterator[bytes]):
    """A streamed read of a live pipe (a process substitution's ``/dev/fd/N``),
    which another task is still writing, so its reader takes the bytes as
    they come.

    Args:
        stream (AsyncIterator[bytes]): the pipe's opened read.
        path (PathSpec): the descriptor it was opened at.
        end (PipeEnd): the pipe itself.
    """

    def __init__(
        self, stream: AsyncIterator[bytes], path: PathSpec, end: PipeEnd
    ) -> None:
        self._stream = stream
        self.path = path
        self.end = end

    async def __anext__(self) -> bytes:
        return await anext(self._stream)

    async def aclose(self) -> None:
        closer = getattr(self._stream, "aclose", None)
        if closer is not None:
            await closer()


# The shape every command returns: a live stdout stream (None when
# buffered into the result) and the command's outcome.
CommandOutput = tuple["ByteSource | None", "IOResult"]


@dataclass(slots=True)
class OutputState:
    """Settlement of a result whose fields fill in as its output drains."""

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
class PathRecord:
    """One path a command reports, before its output is rendered.

    A line spanning mounts renders every mount's records as one output:
    find's actions run over every match, du's rows derive from every
    file counted, wc lays every row out with one width and one total.

    Args:
        path (PathSpec): the path the record names.
        run (int): the start point or operand it belongs to, in operand
            order, so a nested or repeated start point stays its own
            traversal (GNU walks each to completion before the next).
        size (int | None): du's bytes for a file it counted; None for
            a directory its walk met, the operand's own included.
        values (tuple[int, ...]): wc's counts for the row, in GNU's
            column order.
    """

    path: PathSpec
    run: int = 0
    size: int | None = None
    values: tuple[int, ...] = ()


class PathRow(Protocol):
    """A row a command hands over: it names the path it shows."""

    @property
    def path(self) -> PathSpec: ...


RowT = TypeVar("RowT", bound=PathRow)


@dataclass(frozen=True)
class Rows(Generic[RowT]):
    """A command's output as rows, each naming the path it shows, and
    the renderer that prints them.

    The command boundary drops every row whose path the session hides,
    by the rule the dispatcher refuses a call by, and renders the rest,
    so nothing the renderer prints (a name, a count, a total, a column
    width) stands for a hidden path, and no handler checks a hide of
    its own. A handler hands them over on ``IOResult.rows`` with no
    stdout; the renderer runs inside the command's timeout.

    Args:
        items (Sequence[RowT]): the rows, in the order they print.
        render (Callable[[list[RowT]], Awaitable[ByteSource | None]]):
            prints the rows the session sees; None prints nothing.
    """

    items: Sequence[RowT]
    render: Callable[[list[RowT]], Awaitable[ByteSource | None]]


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
        path (str | None): the path the op ran on once the dispatcher
            followed its links, which is what a record names. None until
            the walk is done.
        store (str | None): the backing file a stat resolved to without
            running (``admit_only``): its store and the key in it, alike
            for every workspace that mounts that store. None when no
            mount answers.
    """

    completed: bool = False
    source: str | None = None
    bytes: int | None = None
    path: str | None = None
    store: str | None = None

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
    its lazy stream with ``io_A`` at a provisional ``io_A.exit_code = 0``
    and settles the real value on ``io_A`` only as the stream is drained.
    ``merge()`` therefore links the merged result to its right-hand
    original instead of copying the number, and a read follows the
    link, so the value is exactly as fresh as the origin at the moment
    it is read, however many merges sit in between and however early or
    often it is read.
    An explicit write (``io.exit_code = 124``) stores locally and
    severs the link, so an aggregated or overridden status always
    wins over the lazy one (issue #43). The one rule left for callers
    is the one the shell's barriers already enforce: drain the stream
    before treating the status as final.

    Args:
        records (list[PathRecord] | None): what the command found
            before it is rendered, for commands whose output a later
            step renders again (find's actions, a line spanning mounts):
            find's matches, du's files and directories, wc's rows
            without the total, in operand order. None means the command
            supplied none.
        rows (Rows[Any] | None): the command's output before it is
            rendered, handed over in place of stdout: the command
            boundary drops the rows the session cannot see and renders
            the rest. Never merged: the boundary consumes it.
        stdout (ByteSource | None): Standard output stream.
        stderr (ByteSource | None): Standard error stream.
        exit_code (int): Process exit code.
        producer (Producer | None): provenance of this result (which
            command, spanning which mounts); merge keeps the rightmost
            producer, for attribution, not ownership of aggregate output. The
            workspace boundary hands it to the policy layer as
            context. Facts ride the envelope as policy input; the
            decision a chain hands down rides beside them as
            ``refusal``, written after the last method has spoken.
        refusal (Refusal | None): why the line did not run, when a
            policy or an unanswered ask refused it; None on every
            ordinary run. stderr stays in bash's voice, this carries
            the reason. merge keeps the rightmost record, as it does
            the producer.
        closed_stdout (ClosedPipe | None): how the command answers its
            stdout's reader going away when it does so itself (``tee
            -p``); None leaves the writer to SIGPIPE. merge keeps the
            right-hand one, whose stdout the result carries.
    """

    def __init__(
        self,
        stdout: ByteSource | None = None,
        stderr: ByteSource | None = None,
        exit_code: int = 0,
        producer: Producer | None = None,
        refusal: Refusal | None = None,
        records: list[PathRecord] | None = None,
        closed_stdout: ClosedPipe | None = None,
        rows: Rows[Any] | None = None,
    ) -> None:
        self.stdout = stdout
        self.closed_stdout = closed_stdout
        self.records = records
        self.rows = rows
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
        source = self.stdout
        value = await materialize(source)
        if self.stdout is source:
            self.stdout = value
        return value

    async def stdout_str(self, errors: str = "replace") -> str:
        return (await self.materialize_stdout()).decode(errors=errors)

    async def materialize_stderr(self) -> bytes:
        source = self.stderr
        value = await materialize(source)
        if self.stderr is source:
            self.stderr = value
        return value

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
        # (grep's, at drain time) is still visible.
        result = IOResult(
            stdout=other.stdout,
            records=other.records,
            stderr=merged_stderr,
            producer=other.producer,
            refusal=(
                other.refusal if other.refusal is not None else self.refusal
            ),
            closed_stdout=other.closed_stdout,
        )
        result.output = other.output
        result.output_finalized = other.output_finalized
        result._stream_source = other
        return result
