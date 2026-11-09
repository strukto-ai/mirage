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
import dataclasses
import logging
import posixpath
from collections.abc import Awaitable, Callable
from contextlib import aclosing
from enum import Enum, auto
from functools import partial

from mirage.commands.builtin.utils.paths import walk_spelling
from mirage.context import reset_redirect_paths, set_redirect_paths
from mirage.context.session_context import (
    RedirectGuard,
    RedirectResult,
    bind_caller,
    current_caller,
    reset_caller,
    run_landing,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import is_aborting, strerror_of
from mirage.errors.posix import posix_phrase
from mirage.errors.types import CommandTimeoutError, FsCondition
from mirage.io import IOResult
from mirage.io.async_line_iterator import SharedInput, share
from mirage.io.cooperative import chunks as byte_chunks
from mirage.io.errors import PipeClosed
from mirage.io.spool import MEMORY_LIMIT, spooled_pair
from mirage.io.stream import (
    async_chain,
    discard_streams,
    materialize,
    rechunk,
)
from mirage.io.types import ByteSource, DeviceInput, PipeStream
from mirage.io.writer import ByteWriter
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import Channel, JobConsole, JobOutput, OwnedStream
from mirage.shell.constants import (
    FD_BOTH,
    FD_CLOSE,
    FD_STDERR,
    FD_STDIN,
    FD_STDOUT,
    OUTPUT_ONLY_BUILTINS,
    SIGPIPE_STATUS,
)
from mirage.shell.descriptors import (
    Descriptor,
    FileDescription,
    FileInput,
    Inherited,
    Recorder,
    StreamOwner,
    bad_descriptor_line,
    deliver,
    unreadable_stdin,
    unsupported_descriptor,
)
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import get_text, literal_word
from mirage.shell.types import Redirect, RedirectKind, TSNodeLike
from mirage.shell.voice import shell_voice
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import CycleError, ends_at_dot, owner_prefix
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.background import drained, pump
from mirage.workspace.executor.builtins import _to_scope
from mirage.workspace.executor.builtins.exec import route_rebound
from mirage.workspace.executor.builtins.exec.constants import (
    CLOSED,
    EXEC_STREAM_UNBOUND,
    OPEN_FOR_READ_WRITE,
    OPEN_FOR_READING,
    TO_STDERR,
    TO_STDIN,
    TO_STDOUT,
)
from mirage.workspace.executor.control import (
    UNWINDING,
    carried,
    take_stderr,
    take_stdout,
)
from mirage.workspace.executor.create import (
    create_file,
    sole_stream,
    write_description,
)
from mirage.workspace.executor.statement import write_error_line
from mirage.workspace.mount.registry import DEV_PREFIX
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.shell_dirs import tilde_home
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)

# What these return streams into a redirect's file as it is read; a file
# one reads or writes meanwhile (awk's `print > f`, sed's `w f`, tee's
# operands) first takes what streamed (`PipeRecorder.hold`). What any other
# command returns is replayed once it ends.
STREAM_OUTPUT_BUILTINS = frozenset(
    {
        "cat",
        "head",
        "tail",
        "wc",
        "grep",
        "rg",
        "cut",
        "tr",
        "uniq",
        "nl",
        "paste",
        "comm",
        "join",
        "base64",
        "base32",
        "expand",
        "unexpand",
        "fold",
        "fmt",
        "od",
        "strings",
        "rev",
        "tac",
        "ls",
        "dir",
        "vdir",
        "find",
        "du",
        "stat",
        "readlink",
        "realpath",
        "curl",
        "wget",
        "seq",
        "jq",
        "sort",
        "shuf",
        "xxd",
        "diff",
        "cmp",
        "column",
        "numfmt",
        "tree",
        "file",
        "iconv",
        "zcat",
        "md5sum",
        "b2sum",
        "sha1sum",
        "sha224sum",
        "sha256sum",
        "sha384sum",
        "sha512sum",
        "awk",
        "sed",
        "tee",
    }
)


class _Fd(Enum):
    """Where a descriptor points when no file redirect has claimed it.

    An enum, not a sentinel object: the same variable also holds a
    virtual path string once a redirect lands, and a member can never
    collide with one. CLOSED is where `>&-` points a descriptor: bytes
    written there are dropped, and a command whose stdout was closed
    reports the write failure the way GNU echo does.
    """

    TO_STDOUT = auto()
    TO_STDERR = auto()
    CLOSED = auto()


_TO_STDOUT = _Fd.TO_STDOUT
_TO_STDERR = _Fd.TO_STDERR
_CLOSED = _Fd.CLOSED


class _Unreadable(Enum):
    """A descriptor a read cannot use: closed, or open for writing only."""

    TOKEN = auto()


class PipeRecorder(Recorder):
    """Send FIFO writes immediately; preserve ordinary redirect recording.

    While a pipe is in play (``live``), terminal output goes out as it is
    written, through a copied descriptor too, so it keeps the command's
    order. A write into a pipe whose reader has gone raises ``PipeClosed``.
    A channel ``stream_to`` binds goes into its file as it is written;
    two channels bound to one description share its writer, so they keep
    their order (``> f 2>&1``).

    Args:
        dispatch (DispatchFn): op dispatcher the pipe writes go through.
        streams (dict[Channel, PathSpec]): channels bound to output pipes.
        forward (dict[Channel, Channel]): terminal channels sent through.
        sink (JobConsole | None): where the level writes.
        live (bool): whether any input or output of the level is a pipe.
    """

    def __init__(
        self,
        dispatch: DispatchFn,
        streams: dict[Channel, PathSpec],
        forward: dict[Channel, Channel],
        sink: JobConsole | None,
        live: bool,
    ) -> None:
        super().__init__()
        self.dispatch = dispatch
        self.streams = streams
        self.forward = forward
        self.sink = sink
        self.live = live
        self.bound: dict[Channel, FileDescription] = {}
        self.writers: dict[Channel, tuple[FileDescription, ByteWriter]] = {}
        self.broken: set[int] = set()
        self.resumed: set[int] = set()
        self.session: SessionState | None = None
        self.claimed: frozenset[Channel] = frozenset()
        self.file: FileDescription | None = None
        self.failure: Exception | None = None
        self.streaming = asyncio.Lock()
        self.route: "JobRoute | None" = None

    async def consume(self, file: FileDescription, source: ByteSource) -> None:
        # The write is the redirect's own, so it waits on no hold of its file.
        token = bind_caller(current_caller().changed({"streamed": ()}))
        try:
            await self.dispatch(
                "append" if file.append else "write",
                file.where,
                data=source,
            )
        finally:
            reset_caller(token)

    async def resume(
        self, file: FileDescription, offset: int, source: ByteSource
    ) -> None:
        # What comes once an op reached the file lands at the description's
        # offset, as a descriptor's write does, a block at a time; into a
        # file still empty as one stream, as a description's first write
        # does, which a store that rewrites the file on each pwrite would
        # otherwise copy block after block.
        token = bind_caller(current_caller().changed({"streamed": ()}))
        try:
            if not offset:
                async with sole_stream(self.dispatch, file) as sole:
                    if sole:
                        await self.dispatch("write", file.where, data=source)
                        return
            async with aclosing(rechunk(source, MEMORY_LIMIT)) as parts:
                async for part in parts:
                    await self.dispatch(
                        "pwrite", file.where, data=part, offset=offset
                    )
                    offset += len(part)
        finally:
            reset_caller(token)

    def stream_to(
        self, file: FileDescription, channel: Channel = Channel.STDOUT
    ) -> None:
        self.bound[channel] = file

    def _writer(self, channel: Channel) -> tuple[FileDescription, ByteWriter]:
        """The writer a bound channel's first bytes start, shared by the
        channels bound to one description so they keep their order. None
        starts before bytes come, so a command that writes the file
        itself (``shuf -o f > f``) is not clobbered by an empty write.
        Each write takes all that came while the last one ran, so a
        loop's many small writes cost a backend a few.

        Args:
            channel (Channel): a channel ``stream_to`` bound.
        """
        live = self.writers.get(channel)
        if live is not None:
            return live
        file = self.bound[channel]
        for held, writer in self.writers.values():
            if held is file:
                live = (file, writer)
                break
        else:
            consume = (
                partial(self.resume, file, file.offset)
                if id(file) in self.resumed and not file.append
                else partial(self.consume, file)
            )
            live = (file, ByteWriter(consume, joined=True))
        self.writers[channel] = live
        return live

    def _distinct(self) -> list[tuple[FileDescription, ByteWriter]]:
        seen: dict[int, tuple[FileDescription, ByteWriter]] = {}
        for file, writer in self.writers.values():
            seen.setdefault(id(writer), (file, writer))
        return list(seen.values())

    async def finish_writer(self) -> None:
        """Commit what each bound channel wrote; what comes after is
        recorded, for the level's end to write. A channel whose writer
        failed stays bound, so the rest of its bytes go nowhere."""
        async with self.streaming:
            for file, writer in self._distinct():
                await self._commit(file, writer)
            self._unbind(list(self.bound))

    async def hold(self, file: FileDescription) -> None:
        """Commit what went into ``file`` for an op that reaches it, so
        the op finds it there as a descriptor's writes leave it; what
        comes after goes in at the description's offset, for the next
        op to find (``{ echo A; wc -l < f; echo B; wc -l < f; } > f``).

        Args:
            file (FileDescription): a description ``stream_to`` bound.
        """
        async with self.streaming:
            channels = [c for c, held in self.bound.items() if held is file]
            for writer in {
                id(entry[1]): entry[1]
                for c in channels
                if (entry := self.writers.get(c)) is not None
            }.values():
                await self._commit(file, writer)
            self.resumed.add(id(file))
            for channel in channels:
                live = self.writers.get(channel)
                if live is not None and id(live[1]) not in self.broken:
                    del self.writers[channel]

    async def _commit(self, file: FileDescription, writer: ByteWriter) -> None:
        try:
            await writer.finish()
        except PipeClosed:
            raise
        except Exception as exc:
            if is_aborting(exc):
                raise
            self._failed(file, writer, exc)

    def _unbind(self, channels: list[Channel]) -> None:
        for channel in channels:
            live = self.writers.get(channel)
            if live is None or id(live[1]) not in self.broken:
                self.bound.pop(channel, None)
                self.writers.pop(channel, None)

    async def abort(self) -> None:
        for _, writer in self._distinct():
            await writer.abort()

    def _failed(
        self, file: FileDescription, writer: ByteWriter, exc: Exception
    ) -> None:
        self.broken.add(id(writer))
        if self.failure is None:
            self.failure, self.file = exc, file

    async def _streamed(self, channel: Channel, data: bytes) -> bool:
        """Write bytes into the file their channel is bound to; False
        once ``finish_writer`` let the channel go, so they are recorded
        instead.

        Args:
            channel (Channel): a channel ``stream_to`` bound.
            data (bytes): the bytes.
        """
        async with self.streaming:
            if channel not in self.bound:
                return False
            if not data:
                return True
            if self.bound[channel].lost:
                return True
            file, writer = self._writer(channel)
            if id(writer) not in self.broken:
                try:
                    await writer.write(data)
                    file.offset += len(data)
                except PipeClosed:
                    raise
                except Exception as exc:
                    if is_aborting(exc):
                        raise
                    self._failed(file, writer, exc)
            return True

    async def emit(self, channel: Channel, data: bytes) -> None:
        # An `exec` the command runs points a channel the redirect claimed
        # elsewhere until the command ends (`{ exec >g; echo B; } > f`).
        if channel in self.claimed and self.session is not None:
            routed = await route_rebound(
                self.dispatch, self.session, channel, data
            )
            if routed is not None:
                out, err, refused = routed
                self.refused = self.refused or (
                    refused and channel == Channel.STDOUT
                )
                for to, part in ((Channel.STDOUT, out), (Channel.STDERR, err)):
                    if part:
                        await self.emit_level(to, await materialize(part))
                return
        await self.emit_level(channel, data)

    async def emit_level(self, channel: Channel, data: bytes) -> None:
        """Write bytes through the level's own descriptors, as a write
        through the description it opened does whatever ``exec`` did.

        A write that waited while ``finish_writer`` committed the file
        goes back through the job route: the level may have taken what
        it recorded for the last time, and nothing would read it here.

        Args:
            channel (Channel): the stream the write is on.
            data (bytes): the bytes written.
        """
        if channel in self.bound:
            if await self._streamed(channel, data):
                return
            if self.route is not None:
                await self.route.emit(channel, data)
                return
        scope = self.streams.get(channel)
        if scope is None:
            if self.sink is not None and channel in self.forward:
                await self.sink.emit(self.forward[channel], data)
            else:
                await super().emit(channel, data)
        elif data:
            await self.dispatch("append", scope, data=data)

    async def emit_to(self, stream: OwnedStream, data: bytes) -> None:
        if (
            self.live
            and self.sink is not None
            and isinstance(stream, Inherited)
        ):
            if stream.owner is self:
                await self.sink.emit(stream.channel, data)
                return
            if await deliver(
                self.sink, stream, data, current_caller().enclosing
            ):
                return
        await super().emit_to(stream, data)


class JobRoute(JobOutput):
    """Where a background job started under a redirect writes.

    Into the redirected command's recorder while the command runs, so
    it goes through the descriptors with what the command writes; after
    that straight through them, to the file the redirect opened or the
    stream it pointed at, as bash's job keeps the descriptors it was
    started with.

    Args:
        recorder (Recorder): the redirected command's recorder.
        outputs (dict[int, _Fd | FileDescription | Inherited]): where
            the redirect pointed stdout and stderr.
        outer (JobConsole): where a job writes outside the redirect.
        dispatch (DispatchFn): dispatcher, for a file the job writes later.
        session (SessionState): the shell, for file creation.
    """

    def __init__(
        self,
        recorder: Recorder,
        outputs: dict[int, "_Fd | FileDescription | Inherited"],
        outer: JobConsole,
        dispatch: DispatchFn,
        context: EvaluationContext,
    ) -> None:
        session = context.session
        super().__init__(outer)
        self.owner: StreamOwner = recorder
        self.outputs = outputs
        self.dispatch = dispatch
        self.session = session

    async def emit(self, channel: Channel, data: bytes) -> None:
        """Route what a job wrote: through the level's own descriptors,
        which the job holds whatever ``exec`` its shell runs later
        (``{ cmd & exec >g; } >f`` leaves the job writing ``f``).

        Args:
            channel (Channel): stdout or stderr.
            data (bytes): the bytes.
        """
        recorder = self.recorder
        if isinstance(recorder, PipeRecorder):
            await recorder.emit_level(channel, data)
        elif recorder is not None:
            await recorder.emit(channel, data)
        else:
            await self._write(channel, data)

    async def emit_to(self, stream: OwnedStream, data: bytes) -> None:
        """Route what a job wrote to a stream a level owns.

        Args:
            stream (OwnedStream): the stream the bytes were written to.
            data (bytes): the bytes.
        """
        if self.recorder is not None:
            await self.recorder.emit_to(stream, data)
        elif isinstance(stream, Inherited):
            await self._write(stream, data)
        else:
            await self._write(stream.channel, data)

    def passes(
        self, streams: set[Channel | OwnedStream]
    ) -> set[Channel | OwnedStream]:
        """Which of the level's own writes, or the streams above it, a
        job's streams reach.

        Args:
            streams (set[Channel | OwnedStream]): what the job writes.
        """
        reached: set[Channel | OwnedStream] = set()
        for stream in streams:
            dest: _Fd | FileDescription | OwnedStream | None
            if isinstance(stream, Channel):
                dest = self.outputs.get(1 if stream == Channel.STDOUT else 2)
            else:
                dest = stream
            if dest is _TO_STDOUT:
                reached.add(Channel.STDOUT)
            elif dest is _TO_STDERR:
                reached.add(Channel.STDERR)
            elif isinstance(dest, Inherited):
                reached.add(dest.channel if dest.owner is self.owner else dest)
        return reached

    async def release(self) -> None:
        """Send on, in order, what jobs wrote while the redirect wrote its
        command's output, then let them write straight through. The
        command wrote first. A held write that fails is the job's, which
        has moved on, so it never stops the line that released it."""
        try:
            held = self.recorder
            while isinstance(held, Recorder) and held.busy:
                self.recorder = Recorder()
                for key, source in await held.take():
                    try:
                        async with aclosing(byte_chunks(source)) as stream:
                            async for data in stream:
                                await self._write(key, data)
                    except FS_ERRORS as exc:
                        logger.debug("held job write failed: %s", exc)
                held = self.recorder
        finally:
            self.recorder = None

    async def _write(self, key: Channel | Inherited, data: bytes) -> None:
        """Write through the redirect's descriptors.

        Args:
            key (Channel | Inherited): the channel, or a level's stream.
            data (bytes): the bytes.
        """
        if isinstance(key, Inherited):
            if key.owner is self.owner:
                await self.target.emit(key.channel, data)
            else:
                await self.target.emit_to(key, data)
            return
        dest = self.outputs[1 if key == Channel.STDOUT else 2]
        if dest is _TO_STDOUT:
            await self.target.emit(Channel.STDOUT, data)
        elif dest is _TO_STDERR:
            await self.target.emit(Channel.STDERR, data)
        elif isinstance(dest, Inherited):
            await self.target.emit_to(dest, data)
        elif isinstance(dest, FileDescription):
            await write_description(self.dispatch, self.session, dest, data)


async def _keep_output(
    recorder: PipeRecorder,
    outputs: dict[int, "_Fd | FileDescription | Inherited"],
    dispatch: DispatchFn,
    session: SessionState,
) -> None:
    """Keep in its files what a cancelled command wrote, as a program a
    signal ends leaves its writes in them: the stream going to one is
    committed, and the output held for one is written. What was bound
    for the terminal goes nowhere, since the command's line or job has
    ended. A second cancel waits for this, so the files are whole.

    Args:
        recorder (PipeRecorder): the command's recorder.
        outputs (dict[int, _Fd | FileDescription | Inherited]): where
            the redirect pointed each descriptor.
        dispatch (DispatchFn): operation dispatcher.
        session (SessionState): file creation mode.
    """

    async def keep() -> None:
        await recorder.finish_writer()
        for key, data in await recorder.take():
            dest = (
                outputs[1 if key == Channel.STDOUT else 2]
                if isinstance(key, Channel)
                else None
            )
            if not isinstance(dest, FileDescription):
                await discard_streams(data)
                continue
            try:
                await write_description(dispatch, session, dest, data)
            except FS_ERRORS as exc:
                logger.debug("kept output not written: %s", exc)

    kept = asyncio.ensure_future(keep())
    while not kept.done():
        try:
            await asyncio.shield(kept)
        except asyncio.CancelledError:
            logger.debug("cancelled again while keeping output")
    kept.result()


def _persistently_closed(context: EvaluationContext) -> set[int]:
    """The descriptors an ``exec`` closed for the shell, which a line's
    dup from refuses before the command runs.

    Args:
        context (EvaluationContext): the evaluation's session and frame.
    """
    session = context.session
    closed: set[int] = set()
    if session.exec_stdin_identity == CLOSED:
        closed.add(FD_STDIN)
    if session.exec_stdout == CLOSED:
        closed.add(FD_STDOUT)
    if session.exec_stderr == CLOSED:
        closed.add(FD_STDERR)
    return closed


def _stdin_dest(context: EvaluationContext) -> _Fd | str:
    """Where a write through fd 0 lands, read off the shell's bindings.

    Its own read end, a closed descriptor and a file's read end take
    no write (`echo x >&0` is bash's `write error: Bad file descriptor`
    with stdin a pipe); a terminal stream dup'd onto it (`exec 0<&1`)
    writes where that stream goes; a file opened for writing
    (`exec 0>f`) is the file.

    Args:
        context (EvaluationContext): the evaluation's session and frame.
    """
    session = context.session
    identity = session.exec_stdin_identity
    if (
        identity is None
        or identity == CLOSED
        or identity.startswith(OPEN_FOR_READING)
    ):
        return _CLOSED
    if identity == TO_STDOUT:
        return _TO_STDOUT
    if identity == TO_STDERR:
        return _TO_STDERR
    return identity


async def handle_redirect(
    execute_node: Callable[..., Awaitable[RedirectResult]],
    dispatch: DispatchFn,
    command: TSNodeLike | None,
    redirects: list[Redirect],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    capture_input: bool = False,
    sink: JobConsole | None = None,
    expand: Callable[[Redirect], Awaitable[Redirect]] | None = None,
    guard: RedirectGuard | None = None,
    name: str = "",
    args: tuple[str, ...] = (),
    forked: bool = False,
    follow: Callable[[str], str] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Apply ordered descriptor bindings for one command and restore them.

    Each target expands, is admitted, and opens before the next target
    expands. Earlier opens therefore affect later globs and substitutions,
    and a failure stops the remaining redirects. The last target of an
    output-only builtin, a ``>`` one, is opened by the write of its output
    instead (``_output_only``), so a store that replaces whole objects
    takes one write and never shows the file emptied. Descriptors alias shared
    file descriptions, including their read/write offsets. A stream the
    statement redirects is its own while it runs, in the lines it runs too
    (``eval``, ``exec CMD``, ``bash -c``): an earlier ``exec >`` binding
    of it waits until the statement ends. What the command wrote on its
    way out goes where it writes, and only adjacent writes to one file
    combine, as distinct descriptions may reach it through aliases. A job
    it started writes after its output, or straight through once it
    raised. When the program an ``exec`` ran cannot write its output, that
    failure's status is the shell's.

    Args:
        execute_node (Callable): executor for the redirected command.
        dispatch (DispatchFn): workspace operation dispatcher.
        command (TSNodeLike | None): command, or a redirect-only statement.
        redirects (list[Redirect]): redirects in source order.
        context (EvaluationContext): enclosing descriptor bindings.
        stdin (ByteSource | None): inherited input.
        call_stack (CallStack | None): function stack.
        capture_input (bool): capture a redirect-only substitution's input.
        sink (JobConsole | None): destination for terminal output.
        expand (Callable | None): expand one target immediately before opening.
        guard (RedirectGuard | None): admit each resolved target before I/O.
        name (str): command name for the output-only fast path.
        args (tuple[str, ...]): expanded command arguments.
        forked (bool): whether bash forks to run the command, so a
            closed pipe ends it alone.
        follow (Callable[[str], str] | None): resolves a path's links,
            to tell whether two targets are one file.
    """
    owned: list[SharedInput] = []
    try:
        return await _handle_redirect(
            owned,
            execute_node,
            dispatch,
            command,
            redirects,
            context,
            stdin,
            call_stack,
            capture_input,
            sink,
            expand,
            guard,
            name,
            args,
            forked,
            follow,
        )
    finally:
        await context.session.release_inputs(owned)


def _open_descriptors(
    context: EvaluationContext, stdin: ByteSource | None
) -> tuple[
    dict[int, ByteSource | None | _Unreadable],
    dict[int, _Fd | FileDescription | Inherited],
    set[int],
]:
    """The descriptors a command starts from, before its redirections.

    Args:
        context (EvaluationContext): the line's evaluation context.
        stdin (ByteSource | None): the command's input.

    Returns:
        What each descriptor reads, where each writes, and the closed ones.
    """
    session = context.session
    inputs: dict[int, ByteSource | None | _Unreadable] = {
        0: share(stdin),
        1: _Unreadable.TOKEN,
        2: _Unreadable.TOKEN,
    }
    outputs: dict[int, _Fd | FileDescription | Inherited] = {
        0: _CLOSED,
        1: _TO_STDOUT,
        2: _TO_STDERR,
    }
    stdin_dest = _stdin_dest(context)
    outputs[0] = (
        FileDescription(_ensure_scope(stdin_dest), append=True, opened=True)
        if isinstance(stdin_dest, str)
        else stdin_dest
    )
    if 0 in session.descriptors and session.descriptors[0].file is not None:
        outputs[0] = session.descriptors[0].file
    if isinstance(stdin, FileInput):
        outputs[0] = stdin.description
    if isinstance(session.exec_stdin, FileInput):
        outputs[0] = session.exec_stdin.description
    for fd, binding, held_input in (
        (1, session.exec_stdout, session.exec_stdout_input),
        (2, session.exec_stderr, session.exec_stderr_input),
    ):
        if binding is not None and binding.startswith(OPEN_FOR_READING):
            inputs[fd] = held_input
        elif binding == TO_STDIN:
            inputs[fd] = inputs[0]
    closed = _persistently_closed(context)
    for fd, descriptor in session.descriptors.items():
        if fd <= 2:
            continue
        inputs[fd] = (
            descriptor.source
            if descriptor.source is not None
            else _Unreadable.TOKEN
        )
        outputs[fd] = _descriptor_output(descriptor)
        if descriptor.identity == CLOSED:
            closed.add(fd)
    return inputs, outputs, closed


def _output_recorder(
    dispatch: DispatchFn,
    outputs: dict[int, _Fd | FileDescription | Inherited],
    files: list[FileDescription],
    piped: set[int],
    sink: JobConsole | None,
    command: TSNodeLike | None,
    follow: Callable[[str], str] | None,
) -> PipeRecorder:
    """The recorder a command's output goes through, bound to its files.

    Args:
        dispatch (DispatchFn): the session's op dispatcher.
        outputs (dict[int, _Fd | FileDescription | Inherited]): where each
            descriptor writes.
        files (list[FileDescription]): the files the redirections opened.
        piped (set[int]): the descriptors reading a pipe.
        sink (JobConsole | None): the enclosing console, if any.
        command (TSNodeLike | None): the redirected command, if any.
        follow (Callable[[str], str] | None): resolves a path's links.
    """
    streams: dict[Channel, PathSpec] = {}
    forward: dict[Channel, Channel] = {}
    for fd, channel in ((1, Channel.STDOUT), (2, Channel.STDERR)):
        target = outputs[fd]
        if target is _TO_STDOUT or target is _TO_STDERR:
            forward[channel] = (
                Channel.STDOUT if target is _TO_STDOUT else Channel.STDERR
            )
        elif isinstance(target, FileDescription) and target.pipe:
            streams[channel] = target.scope
    live = bool(streams) or bool(piped)
    recorder = PipeRecorder(
        dispatch, streams, forward if live else {}, sink, live
    )
    for file in files:
        if file.source is None:
            for fd, channel in ((1, Channel.STDOUT), (2, Channel.STDERR)):
                if outputs[fd] is file:
                    file.emit = partial(recorder.emit_level, channel)
                    break
    # What the command writes as it runs (a group's, a loop's, a
    # function's statements) goes into its file as it is written, its
    # stderr too when it shares the description (`> f 2>&1`); an op that
    # reaches the file first commits what went in (`hold`). A stderr
    # that opened the same file again (`> f 2> f`) keeps both waiting,
    # so each write lands at its own description's offset.
    target = outputs[1]
    errs = outputs[2]
    if (
        isinstance(target, FileDescription)
        and target in files
        and target.source is None
        and not target.pipe
    ):
        landed = _followed(target.scope, follow)
        recorder.output_file = landed
        if (
            command is not None
            and target.opened
            and (
                errs is target
                or not isinstance(errs, FileDescription)
                or not _one_file(errs.scope, target.scope, follow)
            )
        ):
            target.landed = PathSpec.from_str_path(landed)
            recorder.output_file = target
            recorder.stream_to(target)
            if errs is target:
                recorder.stream_to(target, Channel.STDERR)
    return recorder


async def _before_drain(
    recorder: PipeRecorder,
    result: RedirectResult,
    outputs: dict[int, _Fd | FileDescription | Inherited],
    files: list[FileDescription],
    name: str,
) -> None:
    """Settle how the command's output reaches its files as it drains.

    Args:
        recorder (PipeRecorder): the command's recorder.
        result (RedirectResult): what the command returned.
        outputs (dict[int, _Fd | FileDescription | Inherited]): where each
            descriptor writes.
        files (list[FileDescription]): the files the redirections opened.
        name (str): the command's name.
    """
    refused = result[2].refused
    errs = outputs[2]
    target = outputs[1]
    # A command reading the file it writes (`cat f >> f`, `grep
    # -r x d > d/f`) would read its own output back.
    producer = result[1].producer
    if refused:
        await recorder.finish_writer()
    elif (
        isinstance(target, FileDescription)
        and result[0] is not None
        and result[0] != b""
        and not (
            (
                name in STREAM_OUTPUT_BUILTINS
                or (producer is not None and producer.native)
            )
            and owner_prefix(
                (p.virtual for p in result[2].paths),
                target.scope.virtual,
            )
            is None
        )
    ):
        await recorder.finish_writer()
    # A program's stderr goes into its own file as it is
    # written too.
    if (
        not refused
        and producer is not None
        and producer.native
        and not recorder.chunks
        and isinstance(errs, FileDescription)
        and errs is not target
        and errs in files
        and errs.source is None
        and not errs.pipe
    ):
        recorder.stream_to(errs, Channel.STDERR)


async def _deliver_routed(
    routed: list[tuple[Channel | Inherited, ByteSource]],
    sink: JobConsole | None,
    io: IOResult,
) -> ByteSource | None:
    """Hand a command's routed output to its console, or keep it.

    Args:
        routed (list[tuple[Channel | Inherited, ByteSource]]): the output
            that left no file behind, by destination.
        sink (JobConsole | None): the enclosing console, if any.
        io (IOResult): where kept stderr lands.

    Returns:
        The stdout the caller still has to take.
    """
    stdout: ByteSource | None = None
    io.stderr = None
    kept: list[tuple[Channel, ByteSource]] = []
    for key, data in routed:
        if isinstance(key, Inherited):
            if not await deliver(sink, key, data, current_caller().enclosing):
                kept.append((key.channel, data))
        elif sink is not None:
            async with aclosing(byte_chunks(data)) as source:
                async for part in source:
                    await sink.emit(key, part)
        else:
            kept.append((key, data))
    if sink is not None:
        for channel, data in kept:
            async with aclosing(byte_chunks(data)) as source:
                async for part in source:
                    await sink.emit(channel, part)
    else:
        stdout, io.stderr = await spooled_pair(
            async_chain(d for c, d in kept if c == Channel.STDOUT),
            async_chain(d for c, d in kept if c != Channel.STDOUT),
        )
    return stdout


@dataclasses.dataclass
class _Opened:
    """A redirect list as its operators have opened it so far.

    Args:
        dispatch (DispatchFn): the op dispatcher.
        session (SessionState): the session running the command.
        sink (JobConsole | None): where the command's output streams.
        stdin (ByteSource | None): the command's input.
        inputs (dict[int, ByteSource | None | _Unreadable]): what each
            descriptor reads.
        outputs (dict[int, _Fd | FileDescription | Inherited]): where
            each descriptor writes.
        closed (set[int]): the closed descriptors.
        files (list[FileDescription]): the files opened to write.
        targets (tuple[PathSpec, ...]): the paths named so far.
        read_paths (dict[int, str]): the file each descriptor reads.
        piped (set[int]): the descriptors reading a pipe.
        deferred (FileDescription | None): the final target, opened by
            the write of the command's output.
        opening_stderr (_Fd | FileDescription | Inherited): where stderr
            pointed when the deferred target would have opened.
        complete_output (FileDescription | None): the final target of an
            output-only command.
    """

    dispatch: DispatchFn
    session: SessionState
    sink: JobConsole | None
    stdin: ByteSource | None
    inputs: dict[int, ByteSource | None | _Unreadable]
    outputs: dict[int, _Fd | FileDescription | Inherited]
    closed: set[int]
    files: list[FileDescription] = dataclasses.field(default_factory=list)
    targets: tuple[PathSpec, ...] = ()
    read_paths: dict[int, str] = dataclasses.field(default_factory=dict)
    piped: set[int] = dataclasses.field(default_factory=set)
    deferred: FileDescription | None = None
    opening_stderr: _Fd | FileDescription | Inherited = _TO_STDERR
    complete_output: FileDescription | None = None

    def reopen(self, fd: int) -> None:
        """Forget what a descriptor had closed or was reading.

        Args:
            fd (int): the descriptor an operator takes over.
        """
        self.closed.discard(fd)
        self.read_paths.pop(fd, None)

    async def failed(
        self,
        result: RedirectResult,
        failed_file: FileDescription | None = None,
    ) -> RedirectResult:
        """Send a refusal where stderr points by now.

        Args:
            result (RedirectResult): the refusal.
            failed_file (FileDescription | None): the file it is about.
        """
        stdout, io, node = result
        data = await io.materialize_stderr()
        target = (
            self.opening_stderr
            if failed_file is not None
            and failed_file is self.deferred
            and not failed_file.opened
            else self.outputs[2]
        )
        if target is _TO_STDERR:
            return result
        io.stderr = None
        if target is _TO_STDOUT:
            stdout = data
        else:
            try:
                if isinstance(target, FileDescription):
                    if (
                        failed_file is None
                        or target.scope.virtual != failed_file.scope.virtual
                    ):
                        await write_description(
                            self.dispatch, self.session, target, data
                        )
                elif isinstance(target, Inherited):
                    if not await deliver(
                        self.sink, target, data, current_caller().enclosing
                    ):
                        if target.channel == Channel.STDOUT:
                            stdout = data
                        else:
                            io.stderr = data
            except PipeClosed:
                raise
            except Exception as exc:
                if is_aborting(exc):
                    raise
                logger.debug("redirect error reporting failed: %s", exc)
        return stdout, io, node


def _unusable(r: Redirect) -> RedirectResult | None:
    """What a target that expanded to nothing usable says, else None.

    Args:
        r (Redirect): the expanded operator.
    """
    if r.kind == RedirectKind.AMBIGUOUS:
        word = (
            r.target.raw_path
            if isinstance(r.target, PathSpec)
            else str(r.target)
        )
        return _shell_failure(
            encode_text(f"{shell_voice()}{word}: ambiguous redirect\n")
        )
    if r.kind == RedirectKind.UNEXPANDED and isinstance(r.target, ExitSignal):
        return _shell_failure(r.target.stderr, r.target.exit_code)
    return None


def _duplicate(opened: _Opened, r: Redirect, target: int) -> int | None:
    """Apply ``N>&M`` or ``N>&-``.

    Args:
        opened (_Opened): the descriptors so far.
        r (Redirect): the operator.
        target (int): the descriptor it copies, or FD_CLOSE.

    Returns:
        The descriptor that refuses it, None when it applied.
    """
    inputs, outputs = opened.inputs, opened.outputs
    if target == FD_CLOSE:
        opened.closed.add(r.fd)
        opened.read_paths.pop(r.fd, None)
        inputs[r.fd], outputs[r.fd] = _Unreadable.TOKEN, _CLOSED
    elif target != r.fd:
        if target in opened.closed or target not in outputs:
            return target
        source = inputs[target]
        if not isinstance(source, _Unreadable):
            source = share(source if source is not None else b"")
            inputs[target] = source
        inputs[r.fd], outputs[r.fd] = source, outputs[target]
        if target in opened.read_paths:
            opened.read_paths[r.fd] = opened.read_paths[target]
        else:
            opened.read_paths.pop(r.fd, None)
        opened.closed.discard(r.fd)
    return None


def _here_input(opened: _Opened, r: Redirect) -> None:
    """Point a descriptor at a here-document or here-string.

    Args:
        opened (_Opened): the descriptors so far.
        r (Redirect): the operator.
    """
    opened.reopen(r.fd)
    opened.outputs[r.fd] = _CLOSED
    data = r.target
    if isinstance(data, str):
        if r.kind == RedirectKind.HERESTRING:
            if len(data) >= 2 and data[0] == data[-1] and data[0] in "\"'":
                data = data[1:-1]
            data += "\n"
        data = encode_text(data)
    opened.inputs[r.fd] = data if r.fd == 0 else SharedInput(data)


async def _open_input(
    opened: _Opened,
    r: Redirect,
    scope: PathSpec,
    owned: list[SharedInput],
) -> RedirectResult | None:
    """Open ``<`` or ``<>``.

    Args:
        opened (_Opened): the descriptors so far.
        r (Redirect): the operator.
        scope (PathSpec): its file.
        owned (list[SharedInput]): the inputs the line closes.

    Returns:
        The refusal, None when it opened.
    """
    dispatch, session = opened.dispatch, opened.session
    inputs, outputs = opened.inputs, opened.outputs
    try:
        if scope.virtual == "/dev/stdin" and r.kind == RedirectKind.STDIN:
            opened.reopen(r.fd)
            inputs[r.fd], outputs[r.fd] = opened.stdin, _CLOSED
            return None
        data, _ = await dispatch("read", scope, stream=True)
    except FileNotFoundError as exc:
        if r.kind != RedirectKind.READWRITE:
            return await opened.failed(_redirect_failure(scope, exc))
        data = b""
    except Exception as exc:
        if is_aborting(exc):
            raise
        return await opened.failed(_redirect_failure(scope, exc))
    opened.reopen(r.fd)
    outputs[r.fd] = _CLOSED
    if r.kind == RedirectKind.READWRITE:
        file = FileDescription(scope, append=True, opened=True)
        file.source = FileInput(file, data or b"")
        owned.append(file.source)
        try:
            await create_file(dispatch, session, scope, b"", append=True)
        except PipeClosed:
            raise
        except Exception as exc:
            if is_aborting(exc):
                raise
            return await opened.failed(_redirect_failure(scope, exc))
        opened.files.append(file)
        inputs[r.fd], outputs[r.fd] = file.source, file
        return None
    opened.read_paths[r.fd] = scope.virtual
    if isinstance(data, PipeStream):
        opened.piped.add(r.fd)
    reading = SharedInput(
        data or b"", seekable=not isinstance(data, PipeStream)
    )
    if not isinstance(data, PipeStream):
        owned.append(reading)
    if (
        not isinstance(data, PipeStream)
        and not await reading.lines.peek()
        and await _stat_type(dispatch, scope) == FileType.CHAR_DEVICE
    ):
        await reading.discard()
        inputs[r.fd] = DeviceInput()
        return None
    inputs[r.fd] = reading
    return None


async def _open_output(
    opened: _Opened,
    r: Redirect,
    scope: PathSpec,
    last: bool,
    command: TSNodeLike | None,
    guard: RedirectGuard | None,
) -> RedirectResult | None:
    """Open ``>`` or ``>>``.

    Args:
        opened (_Opened): the descriptors so far.
        r (Redirect): the operator.
        scope (PathSpec): its file.
        last (bool): the final operator of an output-only command.
        command (TSNodeLike | None): the redirected command.
        guard (RedirectGuard | None): the admission gate of its targets.

    Returns:
        The refusal, None when it opened.
    """
    file: FileDescription
    if (
        last
        and not r.append
        and not scope.virtual.startswith(DEV_PREFIX)
        and not opened.piped
        and not any(f.pipe for f in opened.files)
    ):
        file = opened.deferred = FileDescription(scope)
        opened.opening_stderr = opened.outputs[2]
    else:
        token = (
            set_redirect_paths(command.id, opened.targets)
            if command is not None and guard is not None
            else None
        )
        try:
            pipe = await create_file(
                opened.dispatch, opened.session, scope, b"", append=r.append
            )
        except PipeClosed:
            raise
        except Exception as exc:
            if is_aborting(exc):
                raise
            return await opened.failed(_redirect_failure(scope, exc))
        finally:
            if token is not None:
                reset_redirect_paths(token)
        file = FileDescription(
            pipe or scope,
            append=r.append or pipe is not None,
            opened=True,
            pipe=pipe is not None,
        )
    if not r.append:
        emptied = SharedInput(b"")
        for fd, path in opened.read_paths.items():
            if path == scope.virtual:
                opened.inputs[fd] = emptied
    if last:
        opened.complete_output = file
    opened.files.append(file)
    for fd in [1, 2] if r.fd == FD_BOTH else [r.fd]:
        opened.reopen(fd)
        opened.inputs[fd], opened.outputs[fd] = _Unreadable.TOKEN, file
    return None


async def _land_output(
    opened: _Opened,
    recorder: PipeRecorder,
    route: JobRoute,
    io: IOResult,
    redirects: list[Redirect],
    command: TSNodeLike | None,
    refused: bool,
    unwound: Exception | None,
    forked: bool,
) -> tuple[ByteSource | None, Exception | None]:
    """Write what the command said to the files its operators opened and
    route the rest.

    Args:
        opened (_Opened): the descriptors the operators left.
        recorder (PipeRecorder): what the command wrote.
        route (JobRoute): the route its jobs write through.
        io (IOResult): the command's result, whose status a failed write
            sets.
        redirects (list[Redirect]): the expanded operators.
        command (TSNodeLike | None): the redirected command.
        refused (bool): a policy refused the command.
        unwound (Exception | None): the signal unwinding it.
        forked (bool): bash forks to run it.

    Returns:
        The stdout left for the caller, and what still unwinds.
    """
    dispatch, session = opened.dispatch, opened.session
    stdout: ByteSource | None = None
    route.recorder = Recorder()
    if recorder.failure is not None and recorder.file is not None:
        out, error, _ = await opened.failed(
            _redirect_failure(recorder.file.scope, recorder.failure),
            failed_file=recorder.file,
        )
        if out:
            async with aclosing(byte_chunks(out)) as source:
                async for piece in source:
                    await recorder.emit(Channel.STDOUT, piece)
        diagnostic = await error.materialize_stderr()
        if diagnostic:
            await recorder.emit(Channel.STDERR, diagnostic)
        io.exit_code = 1
    try:
        chunks = await recorder.take()
        if refused:
            outputs: dict[int, _Fd | FileDescription | Inherited] = {
                0: _CLOSED,
                1: _TO_STDOUT,
                2: _TO_STDERR,
            }
            for r in redirects:
                if isinstance(r.target, int):
                    outputs[r.fd] = outputs.get(r.target, _CLOSED)
            opened.outputs = outputs
        if (
            opened.outputs[1] is _CLOSED
            and command is not None
            and any(c == Channel.STDOUT for c, _ in chunks)
        ):
            chunks.append(
                (Channel.STDERR, _closed_write_line(command, unwound))
            )
            io.exit_code = 1

        def dest(
            key: Channel | Inherited,
        ) -> _Fd | FileDescription | Inherited:
            if not isinstance(key, Inherited):
                return opened.outputs[1 if key == Channel.STDOUT else 2]
            if key.owner is not recorder:
                return key
            return _TO_STDOUT if key.channel == Channel.STDOUT else _TO_STDERR

        routed: list[tuple[Channel | Inherited, ByteSource]] = []
        write_token = (
            set_redirect_paths(command.id, opened.targets)
            if command is not None
            else None
        )

        async def write(
            file: FileDescription, data: ByteSource, *, replace: bool = False
        ) -> bool:
            nonlocal unwound
            try:
                await write_description(
                    dispatch, session, file, data, replace=replace
                )
            except PipeClosed:
                # The deferred open reached a pipe (a link to one): its
                # closed reader is the writer's SIGPIPE, as an open would be.
                if file is not opened.deferred:
                    raise
                if forked:
                    io.exit_code = SIGPIPE_STATUS
                elif unwound is None:
                    unwound = ExitSignal(SIGPIPE_STATUS)
                return False
            except Exception as exc:
                if is_aborting(exc):
                    raise
                out, error, _ = await opened.failed(
                    _redirect_failure(file.scope, exc), failed_file=file
                )
                if out:
                    routed.append((Channel.STDOUT, await materialize(out)))
                diagnostic = await error.materialize_stderr()
                if diagnostic:
                    routed.append((Channel.STDERR, diagnostic))
                io.exit_code = 1
                return False
            return True

        try:
            if (
                opened.deferred is not None
                and not (
                    chunks
                    and not refused
                    and all(dest(key) is opened.deferred for key, _ in chunks)
                )
                and not await write(opened.deferred, b"")
            ):
                await discard_streams(*(data for _, data in chunks))
                chunks = []
            pending = iter(chunks)
            chunk = next(pending, None)
            while chunk is not None:
                key, data = chunk
                target = dest(key)
                chunk = next(pending, None)
                if isinstance(target, FileDescription):
                    parts = [data]
                    while chunk is not None and dest(chunk[0]) is target:
                        parts.append(chunk[1])
                        chunk = next(pending, None)
                    await write(
                        target,
                        parts[0] if len(parts) == 1 else async_chain(parts),
                        replace=not refused
                        and target is opened.complete_output
                        and len(parts) == len(chunks),
                    )
                elif target is _TO_STDOUT:
                    routed.append((Channel.STDOUT, data))
                elif target is _TO_STDERR:
                    routed.append((Channel.STDERR, data))
                elif isinstance(target, Inherited):
                    routed.append((target, data))
                else:
                    await discard_streams(data)
        finally:
            if write_token is not None:
                reset_redirect_paths(write_token)
        stdout = await _deliver_routed(routed, opened.sink, io)
    finally:
        await route.release()
    return stdout, unwound


async def _handle_redirect(
    owned: list[SharedInput],
    execute_node: Callable[..., Awaitable[RedirectResult]],
    dispatch: DispatchFn,
    command: TSNodeLike | None,
    redirects: list[Redirect],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    capture_input: bool = False,
    sink: JobConsole | None = None,
    expand: Callable[[Redirect], Awaitable[Redirect]] | None = None,
    guard: RedirectGuard | None = None,
    name: str = "",
    args: tuple[str, ...] = (),
    forked: bool = False,
    follow: Callable[[str], str] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    session = context.session
    bad_fd = unsupported_descriptor(redirects)
    if bad_fd is not None:
        return _shell_failure(bad_descriptor_line(bad_fd))
    inputs, outputs, closed = _open_descriptors(context, stdin)
    opened = _Opened(dispatch, session, sink, stdin, inputs, outputs, closed)
    expanded: list[Redirect] = []
    admission_stdin = (
        await redirect_stdin(dispatch, redirects, context, stdin)
        if guard is not None
        else stdin
    )
    for raw in redirects:
        r = await expand(raw) if expand is not None else raw
        expanded.append(r)
        unusable = _unusable(r)
        if unusable is not None:
            return await opened.failed(unusable)
        if isinstance(r.target, int):
            bad = _duplicate(opened, r, r.target)
            if bad is not None:
                return await opened.failed(
                    _shell_failure(bad_descriptor_line(bad))
                )
            continue
        if r.kind in (RedirectKind.HEREDOC, RedirectKind.HERESTRING):
            _here_input(opened, r)
            continue
        scope = _ensure_scope(r.target)
        opened.targets = (*opened.targets, scope)
        if guard is not None:
            denied = await guard(opened.targets, admission_stdin)
            if denied is not None:
                return denied
        refusal = await _open_refusal(dispatch, context, [r])
        if refusal is not None:
            return await opened.failed(refusal)
        if r.kind in (RedirectKind.STDIN, RedirectKind.READWRITE):
            failure = await _open_input(opened, r, scope, owned)
        else:
            last = len(expanded) == len(redirects) and _output_only(name, args)
            failure = await _open_output(
                opened, r, scope, last, command, guard
            )
        if failure is not None:
            return failure
    redirects = expanded
    files, piped, targets = opened.files, opened.piped, opened.targets

    recorder = _output_recorder(
        dispatch, outputs, files, piped, sink, command, follow
    )
    unwound: Exception | None = None
    refused = False
    saved = session.descriptors
    claimed = {
        fd for r in redirects for fd in ([1, 2] if r.fd == FD_BOTH else [r.fd])
    }
    session.descriptors = dict(saved)
    recorder.session = session
    recorder.claimed = frozenset(
        Channel.STDOUT if fd == 1 else Channel.STDERR
        for fd in claimed
        if fd in (1, 2)
    )
    for fd in outputs:
        if fd > 2 or fd in claimed:
            session.descriptors[fd] = _describe(
                outputs[fd], inputs[fd], recorder if fd > 2 else None
            )
    token = (
        set_redirect_paths(command.id, targets)
        if command is not None
        else None
    )
    terminal_output = session.terminal_output
    session.terminal_output = terminal_output and outputs[1] is _TO_STDOUT
    job_output = session.job_output
    route = JobRoute(
        recorder,
        outputs,
        job_output or session.tty.jobs,
        dispatch,
        context,
    )
    recorder.route = route
    leave = route.record(recorder)
    session.job_output = route
    outer = current_caller()
    enclosing = bind_caller(
        outer.changed(
            {
                "enclosing": recorder,
                "streamed": (
                    *outer.streamed,
                    *(
                        (file, partial(recorder.hold, file))
                        for file in {
                            id(f): f for f in recorder.bound.values()
                        }.values()
                    ),
                ),
            }
        )
    )
    unbound = {
        field: value
        for fd, fields in EXEC_STREAM_UNBOUND.items()
        if fd in claimed
        for field, value in fields.items()
    }
    held = {field: getattr(session, field) for field in unbound}
    for field, value in unbound.items():
        setattr(session, field, value)
    cancelled: asyncio.CancelledError | CommandTimeoutError | None = None
    try:
        if command is None:
            if capture_input and not isinstance(inputs[0], _Unreadable):
                await pump(recorder, Channel.STDOUT, inputs[0])
            io = IOResult()
        else:
            try:
                result = await execute_node(
                    command,
                    context,
                    unreadable_stdin()
                    if isinstance(inputs[0], _Unreadable)
                    else inputs[0],
                    call_stack,
                    sink=recorder,
                )
                refused = result[2].refused
                await _before_drain(recorder, result, outputs, files, name)
                _, io, exec_node = await drained(recorder, *result)
                await recorder.finish_writer()

            except PipeClosed:
                # SIGPIPE ends a forked writer alone; a builtin's write,
                # in a function or a group too, is the shell's, which dies.
                if not forked:
                    raise ExitSignal(SIGPIPE_STATUS) from None
                io = IOResult(exit_code=SIGPIPE_STATUS)
                await recorder.finish_writer()
    except UNWINDING as sig:
        unwound, io = sig, IOResult()
        output = await take_stdout(sig)
        if output:
            await recorder.emit(Channel.STDOUT, output)
        if not (
            isinstance(sig, ExitSignal)
            and command is not None
            and sig.expanding == command.id
        ):
            diagnostic = await take_stderr(sig)
            if diagnostic:
                await recorder.emit(Channel.STDERR, diagnostic)
        await recorder.finish_writer()
    except (asyncio.CancelledError, CommandTimeoutError) as exc:
        cancelled = exc
    except BaseException:
        await recorder.close()
        raise
    finally:
        if cancelled is None:
            await recorder.abort()
        for field, value in held.items():
            setattr(session, field, value)
        reset_caller(enclosing)
        leave()
        session.job_output = job_output
        for file in files:
            file.emit = None
        session.terminal_output = terminal_output
        if token is not None:
            reset_redirect_paths(token)
        for fd in claimed:
            if fd in saved:
                session.descriptors[fd] = saved[fd]
            else:
                session.descriptors.pop(fd, None)
    if cancelled is not None:
        try:
            await run_landing(
                _keep_output(recorder, outputs, dispatch, session)
            )
        except Exception as exc:
            logger.debug("kept output not written: %s", exc)
        raise cancelled
    stdout, unwound = await _land_output(
        opened,
        recorder,
        route,
        io,
        redirects,
        command,
        refused,
        unwound,
        forked,
    )
    if unwound is not None:
        if (
            isinstance(unwound, ExitSignal)
            and unwound.replaced
            and io.exit_code
        ):
            unwound.exit_code = unwound.contained_code = io.exit_code
        raise await carried(unwound, stdout, IOResult(stderr=io.stderr))
    return (
        stdout,
        io,
        ExecutionNode(
            command="redirect", exit_code=io.exit_code, refused=refused
        ),
    )


def _followed(scope: PathSpec, follow: Callable[[str], str] | None) -> str:
    """The file a target names once its links are resolved, walked as
    typed, links before ``..``, as its open walked it; a loop of links
    names itself.

    Args:
        scope (PathSpec): the target.
        follow (Callable[[str], str] | None): resolves a path's links.
    """
    if follow is None:
        return scope.virtual
    try:
        return posixpath.normpath(follow(walk_spelling(scope, follow)))
    except CycleError:
        return scope.virtual


def _one_file(
    first: PathSpec, second: PathSpec, follow: Callable[[str], str] | None
) -> bool:
    """Whether two targets name one file, through links too.

    Args:
        first (PathSpec): one target.
        second (PathSpec): the other.
        follow (Callable[[str], str] | None): resolves a path's links.
    """
    return first.virtual == second.virtual or _followed(
        first, follow
    ) == _followed(second, follow)


def _output_only(name: str, args: tuple[str, ...]) -> bool:
    """Whether an admitted command reads and writes no file of its own.

    Its final write target can be opened by the write of its output: no
    read it makes can see a target emptied early, and a target that
    cannot be opened fails that write with the error the open would have
    met, the output dropped and the status 1, which is what bash shows
    for a command it never ran. ``printf -v`` assigns a variable a
    refused open must stop, so an option ahead of the format opens first.

    Args:
        name (str): the admitted command's name.
        args (tuple[str, ...]): its expanded arguments.
    """
    if name not in OUTPUT_ONLY_BUILTINS:
        return False
    return name != "printf" or not args or not args[0].startswith("-")


def _descriptor_output(
    descriptor: Descriptor,
) -> _Fd | FileDescription | Inherited:
    if descriptor.stream is not None:
        return descriptor.stream
    if descriptor.file is not None:
        return descriptor.file
    if descriptor.identity == TO_STDOUT:
        return _TO_STDOUT
    if descriptor.identity == TO_STDERR:
        return _TO_STDERR
    if descriptor.identity.startswith("/"):
        return FileDescription(
            _ensure_scope(descriptor.identity), append=True, opened=True
        )
    return _CLOSED


def _describe(
    output: _Fd | FileDescription | Inherited,
    source: ByteSource | None | _Unreadable,
    owner: Recorder | None = None,
) -> Descriptor:
    """The binding a descriptor holds for the command a level runs.

    A copy of the level's own stdout or stderr (``3>&1``) names it
    through ``owner``, the level, so it keeps reaching that stream when
    the command rebinds its own (``>f``); fds 1 and 2 stay the command's.

    Args:
        output (_Fd | FileDescription | Inherited): where it writes.
        source (ByteSource | None | _Unreadable): what it reads.
        owner (Recorder | None): the level, for a descriptor above 2.
    """
    if isinstance(output, Inherited):
        return Descriptor(
            TO_STDOUT if output.channel == Channel.STDOUT else TO_STDERR,
            stream=output,
        )
    if owner is not None and output in (_TO_STDOUT, _TO_STDERR):
        channel = Channel.STDOUT if output is _TO_STDOUT else Channel.STDERR
        return Descriptor(
            TO_STDOUT if output is _TO_STDOUT else TO_STDERR,
            stream=Inherited(owner, channel),
        )
    if isinstance(output, FileDescription):
        return Descriptor(
            (OPEN_FOR_READ_WRITE if isinstance(source, FileInput) else "")
            + output.scope.virtual,
            output.append,
            source if isinstance(source, SharedInput) else None,
            output,
        )
    identity = (
        TO_STDOUT
        if output is _TO_STDOUT
        else TO_STDERR
        if output is _TO_STDERR
        else CLOSED
    )
    if isinstance(source, SharedInput) and output is _CLOSED:
        identity = OPEN_FOR_READING
    return Descriptor(
        identity, source=source if isinstance(source, SharedInput) else None
    )


def _redirect_error_line(scope: PathSpec, exc: Exception) -> bytes:
    """GNU stderr line for a redirect target that could not be opened.

    GNU bash 5.2.37 answers both ``cat < missing`` and
    ``echo x > /nosuchdir/f`` with
    ``bash: line 1: <target>: No such file or directory`` and exit 1: the
    error belongs to the shell, not the command, and the rest of the line
    keeps running (``;`` continues, ``&&`` short-circuits, ``||`` runs).

    The label is the target's own spelling, never the exception's message:
    backends raise write failures with prose in ``str(exc)`` (``parent
    directory does not exist: /nodir``), which used to reach the user as
    the path. A store's own error (an SDK's, an HTTP status on upload)
    names no condition, so its message is the only cause there is.

    Args:
        scope (PathSpec): The redirect target that could not be opened.
        exc (Exception): The error raised by the read or write.
    """
    return encode_text(
        f"{shell_voice()}{scope.raw_path}: {strerror_of(exc)}\n"
    )


def _closed_write_line(
    command: TSNodeLike, unwound: Exception | None = None
) -> bytes:
    """GNU's line for a write onto a closed stdout, in the name of what
    wrote: the command, or the program an ``exec`` in it replaced the
    shell with.

    Args:
        command (TSNodeLike): the command whose stdout was closed.
        unwound (Exception | None): the signal it left by, if any.
    """
    if isinstance(unwound, ExitSignal) and unwound.replaced is not None:
        return write_error_line(unwound.replaced, program=True)
    return write_error_line(get_text(command))


def _redirect_failure(
    scope: PathSpec, exc: Exception
) -> tuple[None, IOResult, ExecutionNode]:
    """Shell-attributed IOResult for a redirect target that cannot be opened.

    Args:
        scope (PathSpec): The redirect target that could not be opened.
        exc (Exception): The error raised by the open.
    """
    _, io, node = _shell_failure(_redirect_error_line(scope, exc))
    node.unopened = True
    return None, io, node


def _shell_failure(
    line: bytes, status: int = 1
) -> tuple[None, IOResult, ExecutionNode]:
    """Shell-attributed IOResult that replaces the command's whole run.

    bash never runs the command and stops processing redirects at the
    first failure, so this replaces the whole result. Returning an
    IOResult rather than letting the error propagate is what keeps the
    rest of the line alive; it also stops the workspace-level ``OSError``
    handler from stamping the line's first word onto the message
    (``cd /data && cat < missing`` used to report ``cd:``).

    Args:
        line (bytes): the diagnostic, already in the shell's voice.
        status (int): the status the command fails with.
    """
    io = IOResult(exit_code=status, stderr=line)
    return None, io, ExecutionNode(command="redirect", exit_code=status)


async def redirect_stdin(
    dispatch: DispatchFn,
    redirects: list[Redirect],
    context: EvaluationContext,
    stdin: ByteSource | None,
) -> ByteSource | None:
    """Classify input for admission without expanding or reading targets.

    Literal files are stat'd, including symlinks and replaced devices.
    An unreadable or computed binding conservatively retains the cwd
    search scope until the actual redirect can be resolved in order.

    Args:
        dispatch (DispatchFn): workspace operation dispatcher.
        redirects (list[Redirect]): redirects in source order.
        context (EvaluationContext): enclosing descriptor bindings.
        stdin (ByteSource | None): inherited input.
    """
    session = context.session
    sources: dict[int, ByteSource | None] = {
        fd: d.source for fd, d in session.descriptors.items()
    }
    sources[0] = stdin
    for r in redirects:
        if isinstance(r.target, int):
            sources[r.fd] = sources.get(r.target, DeviceInput())
        elif r.kind in (
            RedirectKind.HEREDOC,
            RedirectKind.HERESTRING,
            RedirectKind.READWRITE,
        ):
            sources[r.fd] = b""
        elif r.kind == RedirectKind.STDIN:
            target = (
                literal_word(r.target_node, tilde_home(session))
                if r.target_node is not None
                else r.target
            )
            if target is None:
                sources[r.fd] = DeviceInput()
                continue
            scope = PathSpec.from_str_path(target, cwd=session.cwd)
            sources[r.fd] = (
                stdin
                if scope.virtual == "/dev/stdin"
                else DeviceInput()
                if await _stat_type(dispatch, scope) == FileType.CHAR_DEVICE
                else b""
            )
        else:
            sources[r.fd] = DeviceInput()
    return sources.get(FD_STDIN)


async def _stat_type(dispatch: DispatchFn, scope: PathSpec) -> FileType | None:
    """What a redirect target is, None when nothing answers there.

    Args:
        dispatch (DispatchFn): VFS op dispatcher.
        scope (PathSpec): the redirect target.
    """
    try:
        stat, _ = await dispatch("stat", scope)
    except Exception as exc:
        if is_aborting(exc):
            raise
        logger.debug(
            "redirect probe found nothing at %s: %s", scope.raw_path, exc
        )
        return None
    return stat.type if isinstance(stat, FileStat) else None


async def _open_refusal(
    dispatch: DispatchFn,
    context: EvaluationContext,
    redirects: list[Redirect],
) -> tuple[None, IOResult, ExecutionNode] | None:
    """Refuse the whole statement when one of its opens cannot happen.

    Returned *instead of* running the command, because that is what bash
    does: it opens every redirect before it forks, so a refusal means
    the command never runs. `set -C; touch marker > existing` leaves no
    marker behind. Deciding this after the fact only matched the file
    contents, and on `rm f > f` it did not even do that -- the command
    deleted its own target first, so the probe found nothing there and
    let the line succeed.

    Two opens refuse. A target typed with a trailing slash is one
    whatever is there: open(2) with O_CREAT answers `missing/` and
    `reg/` alike with EISDIR before looking anything up, so bash prints
    `missing/: Is a directory` and creates nothing, where writing the
    normalized name would have left a regular file called `missing`.
    That test is on the spelling alone and costs no round trip, which is
    a deliberate divergence for a slashed target under a parent that is
    itself absent: bash reports the parent first (ENOENT), this reads
    `Is a directory` too. The other is `set -C`, described next.

    `set -C` refuses a truncating open onto a regular file that already
    exists -- an empty one counts, since the test is existence and not
    size -- while `>>` is always allowed and `>|` overrides for that one
    redirect without clearing the option. A directory reached under the
    option is refused too, in GNU's own wording for that case rather
    than the noclobber one; a device or a pipe (`/dev/null`, a process
    substitution) opens as any write does, as bash's noclobber open lets
    it. bash stops at the first target it cannot open, so the scan
    reports one line and stops.

    Targets are stat'd through the op dispatcher rather than a backend,
    so a redirect that lands on another mount is answered by the mount
    that owns it.

    Args:
        dispatch (DispatchFn): op dispatcher.
        context (EvaluationContext): the session holding the shell options.
        redirects (list[Redirect]): the statement's redirects, in the
            order they were written.

    Returns:
        The refusal result, or None when every open is allowed.
    """
    session = context.session
    noclobber = bool(session.shell_options.get("noclobber"))
    for r in redirects:
        if r.kind in (
            RedirectKind.STDIN,
            RedirectKind.READWRITE,
            RedirectKind.HEREDOC,
            RedirectKind.HERESTRING,
        ) or isinstance(r.target, int):
            continue
        scope = _ensure_scope(r.target)
        # Behind a dot (`x/./`) the open's own walk answers instead.
        if scope.raw_path.endswith("/") and not ends_at_dot(scope.raw_path):
            return _shell_failure(
                encode_text(
                    f"{shell_voice()}{scope.raw_path}: Is a directory\n"
                )
            )
        is_dir = False
        exists = False
        if noclobber and not exists:
            try:
                stat, _ = await dispatch("stat", scope)
            except FS_ERRORS as exc:
                logger.debug(
                    "noclobber probe found no target at %s: %s",
                    scope.raw_path,
                    exc,
                )
                stat = None
            except Exception as exc:
                if is_aborting(exc):
                    raise
                return _redirect_failure(scope, exc)
            exists = stat is not None and stat.type in (
                FileType.FILE,
                FileType.DIRECTORY,
            )
            is_dir = stat is not None and stat.type == FileType.DIRECTORY
        if noclobber and exists and not r.append and not r.clobber:
            detail = (
                posix_phrase(FsCondition.EISDIR)
                if is_dir
                else "cannot overwrite existing file"
            )
            return _shell_failure(
                encode_text(f"{shell_voice()}{scope.raw_path}: {detail}\n")
            )
    return None


def _ensure_scope(target: str | int | PathSpec) -> PathSpec:
    if isinstance(target, PathSpec):
        return target
    if isinstance(target, str):
        return _to_scope(target)
    return _to_scope(str(target))
