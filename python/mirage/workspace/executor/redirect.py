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

import logging
from enum import Enum, auto
from functools import partial

from mirage.context import reset_redirect_paths, set_redirect_paths
from mirage.io import IOResult
from mirage.io.async_line_iterator import SharedInput, share
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, DeviceInput
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
)
from mirage.shell.descriptors import (
    ENCLOSING,
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
from mirage.shell.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.shell.types import Redirect, RedirectKind, TSNodeLike
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, fs_strerror
from mirage.workspace.executor.builtins import _to_scope
from mirage.workspace.executor.builtins.exec.constants import (
    CLOSED,
    OPEN_FOR_READ_WRITE,
    OPEN_FOR_READING,
    TO_STDERR,
    TO_STDIN,
    TO_STDOUT,
)
from mirage.workspace.executor.control import UNWINDING, carried, take_stderr
from mirage.workspace.executor.create import create_file, write_description
from mirage.workspace.executor.jobs import drained, pump
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)


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
        dispatch (DispatchFn): op door, for a file the job writes later.
        session (SessionState): the shell, for file creation.
    """

    def __init__(
        self,
        recorder: Recorder,
        outputs: dict[int, "_Fd | FileDescription | Inherited"],
        outer: JobConsole,
        dispatch: DispatchFn,
        session: SessionState,
    ) -> None:
        super().__init__(outer)
        self.recorder = recorder
        self.owner: StreamOwner = recorder
        self.outputs = outputs
        self.dispatch = dispatch
        self.session = session

    async def emit(self, channel: Channel, data: bytes) -> None:
        """Route what a job wrote.

        Args:
            channel (Channel): stdout or stderr.
            data (bytes): the bytes.
        """
        if self.recorder is not None:
            await self.recorder.emit(channel, data)
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
        command's output, then let them write straight through: the
        command wrote first, and its first write is the one that opens
        the file. A held write that fails is the job's, which has moved
        on, so it never stops the line that released it."""
        try:
            held = self.recorder
            while isinstance(held, Recorder) and held.chunks:
                self.recorder = Recorder()
                for key, data in held.chunks:
                    try:
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


def _persistently_closed(session: SessionState) -> set[int]:
    """The descriptors an ``exec`` closed for the shell, which a line's
    dup from refuses before the command runs.

    Args:
        session (SessionState): shell session state.
    """
    closed: set[int] = set()
    if session.exec_stdin_identity == CLOSED:
        closed.add(FD_STDIN)
    if session.exec_stdout == CLOSED:
        closed.add(FD_STDOUT)
    if session.exec_stderr == CLOSED:
        closed.add(FD_STDERR)
    return closed


def _stdin_dest(session: SessionState) -> _Fd | str:
    """Where a write through fd 0 lands, read off the shell's bindings.

    Its own read end, a closed descriptor and a file's read end take
    no write (`echo x >&0` is bash's `write error: Bad file descriptor`
    with stdin a pipe); a terminal stream dup'd onto it (`exec 0<&1`)
    writes where that stream goes; a file opened for writing
    (`exec 0>f`) is the file.

    Args:
        session (SessionState): shell session state.
    """
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
    execute_node,
    dispatch,
    command: TSNodeLike | None,
    redirects: list[Redirect],
    session: SessionState,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
    capture_input: bool = False,
    sink: JobConsole | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Apply ordered descriptor bindings for one command and restore them.

    Descriptors alias shared file descriptions, including read/write offsets.
    A target opened for writing is emptied before the command runs, as
    bash's open-before-exec does, so ``cat f > f`` reads an empty file and
    ``ls > out`` lists ``out``; a target that cannot be opened stops the
    command before it runs. A ``>>`` target is opened then too, created
    when it is missing, so ``ls >> out`` lists ``out``. A simple command
    opens its targets only once dispatch admits it, so a command the gate
    refuses leaves them as they were. Two opens stay out of bash's order:
    an input that cannot be opened stops the line before any target is
    opened, where bash has emptied the ones written before it, because
    the gate has not judged the line yet; and an input that reaches a
    ``>`` target only through a symlink is read before the target is
    emptied, since the paths are compared as typed.

    Args:
        execute_node (Callable): executor for the redirected command.
        dispatch (DispatchFn): workspace operation dispatcher.
        command (TSNodeLike | None): command, or a redirect-only statement.
        redirects (list[Redirect]): expanded redirects in source order.
        session (SessionState): enclosing descriptor bindings.
        stdin (ByteSource | None): inherited input.
        call_stack (CallStack | None): function stack.
        capture_input (bool): capture a redirect-only substitution's input.
        sink (JobConsole | None): destination for terminal output.
    """
    bad_fd = unsupported_descriptor(redirects)
    if bad_fd is not None:
        return _shell_failure(bad_descriptor_line(bad_fd))
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
    stdin_dest = _stdin_dest(session)
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
    closed = _persistently_closed(session)
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
    files: list[FileDescription] = []
    # bash empties a write target as it opens it, so the command finds
    # nothing to read in the same file through an input redirect.
    truncated: dict[str, int] = {}
    for at, r in enumerate(redirects):
        if (
            r.kind in (RedirectKind.STDOUT, RedirectKind.STDERR)
            and not r.append
            and not isinstance(r.target, int)
        ):
            truncated.setdefault(_ensure_scope(r.target).virtual, at)
    for at, r in enumerate(redirects):
        if r.kind == RedirectKind.AMBIGUOUS:
            return _shell_failure(
                f"{_redirect_word(r)}: ambiguous redirect\n".encode()
            )
        if r.kind == RedirectKind.UNEXPANDED and isinstance(
            r.target, ExitSignal
        ):
            return _shell_failure(r.target.stderr, r.target.exit_code)
        if isinstance(r.target, int):
            if r.target == FD_CLOSE:
                closed.add(r.fd)
                inputs[r.fd], outputs[r.fd] = _Unreadable.TOKEN, _CLOSED
            elif r.target != r.fd:
                if r.target in closed or r.target not in outputs:
                    return _shell_failure(bad_descriptor_line(r.target))
                source = inputs[r.target]
                if not isinstance(source, _Unreadable):
                    source = share(source if source is not None else b"")
                    inputs[r.target] = source
                inputs[r.fd], outputs[r.fd] = source, outputs[r.target]
                closed.discard(r.fd)
            continue
        fds = [1, 2] if r.fd == FD_BOTH else [r.fd]
        for fd in fds:
            closed.discard(fd)
            inputs[fd], outputs[fd] = _Unreadable.TOKEN, _CLOSED
        if r.kind in (RedirectKind.HEREDOC, RedirectKind.HERESTRING):
            data = r.target
            if isinstance(data, str):
                if r.kind == RedirectKind.HERESTRING:
                    if (
                        len(data) >= 2
                        and data[0] == data[-1]
                        and data[0] in "\"'"
                    ):
                        data = data[1:-1]
                    data += "\n"
                data = encode_text(data)
            inputs[r.fd] = data if r.fd == 0 else SharedInput(data)
            continue
        scope = _ensure_scope(r.target)
        if r.kind in (RedirectKind.STDIN, RedirectKind.READWRITE):
            # Opened after the target was emptied there is nothing to
            # read; opened before, the file must still be there.
            emptied_at = (
                truncated.get(scope.virtual)
                if r.kind == RedirectKind.STDIN
                else None
            )
            try:
                if (
                    scope.virtual == "/dev/stdin"
                    and r.kind == RedirectKind.STDIN
                ):
                    inputs[r.fd] = stdin
                    continue
                if emptied_at is not None and emptied_at < at:
                    data = b""
                else:
                    data, _ = await dispatch("read", scope)
            except FileNotFoundError as exc:
                if r.kind != RedirectKind.READWRITE:
                    return _redirect_failure(scope, exc)
                data = b""
            except FS_ERRORS as exc:
                return _redirect_failure(scope, exc)
            data = (
                b""
                if emptied_at is not None
                else await materialize(data) or b""
            )
            if r.kind == RedirectKind.READWRITE:
                file = FileDescription(scope, append=True)
                file.source = FileInput(file, data)
                files.append(file)
                inputs[r.fd], outputs[r.fd] = file.source, file
            else:
                inputs[r.fd] = (
                    DeviceInput()
                    if data == b"" and await _is_device(dispatch, scope)
                    else data
                    if r.fd == 0
                    else SharedInput(data)
                )
        else:
            file = FileDescription(scope, append=r.append)
            files.append(file)
            for fd in fds:
                outputs[fd] = file
    refusal = await _open_refusal(dispatch, session, redirects)
    if refusal is not None:
        return refusal
    opening = [file for file in files if file.source is None]
    opened: set[int] = set()
    failure: list[tuple[PathSpec, OSError]] = []

    async def open_targets() -> bool:
        """Open the statement's write targets, as bash's opens do before
        the command runs: a ``>`` one emptied, a ``>>`` one created when
        it is missing; False, the failure kept, when one cannot be
        opened."""
        while opening:
            file = opening.pop(0)
            try:
                await create_file(
                    dispatch, session, file.scope, b"", append=file.append
                )
            except FS_ERRORS as exc:
                failure.append((file.scope, exc))
                return False
            opened.add(id(file))
        return True

    recorder = Recorder()
    for file in files:
        if file.source is None:
            for fd, channel in ((1, Channel.STDOUT), (2, Channel.STDERR)):
                if outputs[fd] is file:
                    file.emit = partial(recorder.emit, channel)
                    break
    unwound: Exception | None = None
    refused = False
    saved = session.descriptors
    claimed = {
        fd for r in redirects for fd in ([1, 2] if r.fd == FD_BOTH else [r.fd])
    }
    session.descriptors = dict(saved)
    for fd in outputs:
        if fd > 2 or fd in claimed:
            session.descriptors[fd] = _describe(
                outputs[fd], inputs[fd], recorder if fd > 2 else None
            )
    targets = tuple(
        _ensure_scope(r.target)
        for r in redirects
        if not isinstance(r.target, int)
        and r.kind not in (RedirectKind.HEREDOC, RedirectKind.HERESTRING)
    )
    # A simple command opens its targets once dispatch has admitted it
    # (see set_redirect_paths); a compound one has no gate of its own and
    # opens them here, before its body runs.
    simple = command is not None and command.type == NT.COMMAND
    token = (
        set_redirect_paths(
            command.id, targets, open_targets if simple else None
        )
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
        session,
    )
    session.job_output = route
    enclosing = ENCLOSING.set(recorder)
    try:
        if command is None:
            if capture_input and not isinstance(inputs[0], _Unreadable):
                await pump(recorder, Channel.STDOUT, inputs[0])
            io = IOResult()
        elif not simple and not await open_targets():
            io = IOResult()
        else:
            _, io, exec_node = await drained(
                recorder,
                *await execute_node(
                    command,
                    session,
                    unreadable_stdin()
                    if isinstance(inputs[0], _Unreadable)
                    else inputs[0],
                    call_stack,
                    sink=recorder,
                ),
            )
            refused = exec_node.refused
    except UNWINDING as sig:
        unwound, io = sig, IOResult()
        # What the command wrote on its way out goes where it writes; an
        # error expanding its own words came before its redirects.
        if not (
            isinstance(sig, ExitSignal)
            and command is not None
            and sig.expanding == command.id
        ):
            diagnostic = await take_stderr(sig)
            if diagnostic:
                await recorder.emit(Channel.STDERR, diagnostic)
    finally:
        ENCLOSING.reset(enclosing)
        # A body that raised (a cancel, an error) skips the writes below:
        # its jobs write straight through.
        route.recorder = None
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
    stdout: bytes | None = None
    # What a job writes from here waits until the command's own output is
    # written (`route.release()`).
    route.recorder = Recorder()
    try:
        if failure:
            return _redirect_failure(*failure[0])
        chunks = recorder.chunks
        if refused:
            outputs = {0: _CLOSED, 1: _TO_STDOUT, 2: _TO_STDERR}
            for r in redirects:
                if isinstance(r.target, int):
                    outputs[r.fd] = outputs.get(r.target, _CLOSED)
        if (
            outputs[1] is _CLOSED
            and command is not None
            and any(c == Channel.STDOUT for c, _ in chunks)
        ):
            chunks.append((Channel.STDERR, _closed_write_line(command)))
            io.exit_code = 1

        def dest(
            key: Channel | Inherited,
        ) -> _Fd | FileDescription | Inherited:
            if not isinstance(key, Inherited):
                return outputs[1 if key == Channel.STDOUT else 2]
            if key.owner is not recorder:
                return key
            return _TO_STDOUT if key.channel == Channel.STDOUT else _TO_STDERR

        routed: list[tuple[Channel | Inherited, bytes]] = []
        write_token = (
            set_redirect_paths(command.id, targets)
            if command is not None
            else None
        )
        consumed: set[int] = set()
        failed_scope: PathSpec | None = None
        try:
            if not refused:
                for file in files:
                    failed_scope = file.scope
                    unique = (
                        sum(
                            other.scope.virtual == file.scope.virtual
                            for other in files
                        )
                        == 1
                    )
                    data = (
                        b"".join(
                            data for key, data in chunks if dest(key) is file
                        )
                        if unique
                        else b""
                    )
                    if data or id(file) not in opened:
                        await write_description(dispatch, session, file, data)
                    else:
                        file.opened = True
                    if unique:
                        consumed.add(id(file))
                        if data:
                            io.writes[file.scope.virtual] = data
            for key, data in chunks:
                target = dest(key)
                if target is _TO_STDOUT:
                    routed.append((Channel.STDOUT, data))
                elif target is _TO_STDERR:
                    routed.append((Channel.STDERR, data))
                elif isinstance(target, Inherited):
                    routed.append((target, data))
                elif (
                    isinstance(target, FileDescription)
                    and id(target) not in consumed
                ):
                    failed_scope = target.scope
                    await write_description(dispatch, session, target, data)
                    io.writes[target.scope.virtual] = data
        except FS_ERRORS as exc:
            assert failed_scope is not None
            routed.append(
                (Channel.STDERR, _redirect_error_line(failed_scope, exc))
            )
            io.exit_code = 1
        finally:
            if write_token is not None:
                reset_redirect_paths(write_token)
        io.stderr = None
        kept: list[tuple[Channel, bytes]] = []
        for key, data in routed:
            if isinstance(key, Inherited):
                if not await deliver(sink, key, data):
                    kept.append((key.channel, data))
            elif sink is not None:
                await sink.emit(key, data)
            else:
                kept.append((key, data))
        if sink is not None:
            for channel, data in kept:
                await sink.emit(channel, data)
        else:
            stdout = (
                b"".join(d for c, d in kept if c == Channel.STDOUT) or None
            )
            io.stderr = (
                b"".join(d for c, d in kept if c == Channel.STDERR) or None
            )
    finally:
        await route.release()
    if unwound is not None:
        raise await carried(unwound, stdout, IOResult(stderr=io.stderr))
    return (
        stdout,
        io,
        ExecutionNode(
            command="redirect", exit_code=io.exit_code, refused=refused
        ),
    )


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


def _redirect_error_line(scope: PathSpec, exc: OSError) -> bytes:
    """GNU stderr line for a redirect target that could not be opened.

    GNU bash 5.2.37 answers both ``cat < missing`` and
    ``echo x > /nosuchdir/f`` with
    ``bash: line 1: <target>: No such file or directory`` and exit 1: the
    error belongs to the shell, not the command, and the rest of the line
    keeps running (``;`` continues, ``&&`` short-circuits, ``||`` runs).

    Deliberate divergence from bash: the ``bash: line N:`` prefix is
    dropped, so the line is ``<target>: <strerror>``. This matches the
    house style already set by the other shell-attributed error,
    ``nosuchcmd: command not found`` (bash prints
    ``bash: line 1: nosuchcmd: command not found``) — ``bash:`` is bash's
    ``$0`` and mirage is not bash, and ``line N`` has no meaning for a
    one-line ``Workspace.shell`` call.

    The label is the target's own spelling, never the exception's message:
    backends raise write failures with prose in ``str(exc)`` (``parent
    directory does not exist: /nodir``), which used to reach the user as
    the path.

    Args:
        scope (PathSpec): The redirect target that could not be opened.
        exc (OSError): The filesystem error raised by the read or write.
    """
    label = scope.raw_path
    strerror = fs_strerror(exc)
    return (f"{label}: {strerror}\n" if strerror else f"{label}\n").encode()


def _closed_write_line(command: TSNodeLike) -> bytes:
    """GNU's line for a write onto a closed stdout, in the command's name.

    Args:
        command (TSNodeLike): the command whose stdout was closed.
    """
    words = get_text(command).split()
    name = words[0] if words else "redirect"
    return f"{name}: write error: Bad file descriptor\n".encode()


def _redirect_word(r: Redirect) -> str:
    """The redirect's target as typed, for a refusal that names it.

    Args:
        r (Redirect): the redirect, its target expanded or not.
    """
    return (
        r.target.raw_path if isinstance(r.target, PathSpec) else str(r.target)
    )


def _redirect_failure(
    scope: PathSpec, exc: OSError
) -> tuple[None, IOResult, ExecutionNode]:
    """Shell-attributed IOResult for a redirect target that cannot be opened.

    Args:
        scope (PathSpec): The redirect target that could not be opened.
        exc (OSError): The filesystem error raised by the open.
    """
    return _shell_failure(_redirect_error_line(scope, exc))


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


async def _is_device(dispatch: DispatchFn, scope: PathSpec) -> bool:
    """Whether a redirect target is a character device (``/dev/null``).

    Args:
        dispatch (DispatchFn): VFS op dispatcher.
        scope (PathSpec): the redirect target.
    """
    try:
        stat, _ = await dispatch("stat", scope)
    except FS_ERRORS as exc:
        logger.debug(
            "stdin device probe failed at %s: %s", scope.raw_path, exc
        )
        return False
    return isinstance(stat, FileStat) and stat.type == FileType.CHAR_DEVICE


async def _open_refusal(
    dispatch: DispatchFn,
    session: SessionState,
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

    `set -C` refuses a truncating open onto anything that already exists
    -- an empty file counts, since the test is existence and not size --
    while `>>` is always allowed and `>|` overrides for that one
    redirect without clearing the option. A directory reached under the
    option is refused too, in GNU's own wording for that case rather
    than the noclobber one. bash stops at the first target it cannot
    open, so the scan reports one line and stops.

    The opens are modelled in the order they were written, because each
    one is visible to the next: `set -C; echo x > a > a` creates `a` on
    the first redirect and then refuses the second, even though `a` did
    not exist when the statement began. Probing every target against one
    pre-command snapshot passed both and wrote the output. `>>` and `>|`
    never refuse but do create, so they count as opens too.

    The stat is skipped unless the option is on, so the ordinary
    redirect path costs no extra round trip. A directory typed without
    a slash needs none here: the open itself answers `Is a directory`,
    from the kernel on a real filesystem and from the store's own
    directory table on a keyed one, and the write path renders it.

    Targets are stat'd through the op dispatcher rather than a backend,
    so a redirect that lands on another mount is answered by the mount
    that owns it.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): the session holding the shell options.
        redirects (list[Redirect]): the statement's redirects, in the
            order they were written.

    Returns:
        The refusal result, or None when every open is allowed.
    """
    noclobber = bool(session.shell_options.get("noclobber"))
    opened: set[str] = set()
    pending: list[PathSpec] = []
    for r in redirects:
        if r.kind in (
            RedirectKind.STDIN,
            RedirectKind.READWRITE,
            RedirectKind.HEREDOC,
            RedirectKind.HERESTRING,
        ) or isinstance(r.target, int):
            continue
        scope = _ensure_scope(r.target)
        if scope.raw_path.endswith("/"):
            earlier = await _apply_pending_opens(dispatch, pending)
            if earlier is not None:
                return earlier
            return _shell_failure(
                f"{scope.raw_path}: Is a directory\n".encode()
            )
        path = scope.virtual
        is_dir = False
        exists = path in opened
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
            exists = stat is not None
            is_dir = stat is not None and stat.type == FileType.DIRECTORY
        if noclobber and exists and not r.append and not r.clobber:
            earlier = await _apply_pending_opens(dispatch, pending)
            if earlier is not None:
                return earlier
            detail = (
                "Is a directory"
                if is_dir
                else "cannot overwrite existing file"
            )
            return _shell_failure(f"{scope.raw_path}: {detail}\n".encode())
        # This open succeeds, so the target exists for every redirect
        # after it, and a truncating one leaves it empty to be found.
        # Without the option nothing was stat'd, so an append target of
        # unknown standing is not listed: pre-opening it with an empty
        # write would truncate a file that is there.
        opened.add(path)
        if not r.append or (noclobber and not exists):
            pending.append(scope)
    return None


async def _apply_pending_opens(
    dispatch: DispatchFn,
    pending: list[PathSpec],
) -> tuple[None, IOResult, ExecutionNode] | None:
    """Apply the opens a refused statement already performed.

    bash opens redirects left to right, so the ones before the refused
    one have happened by the time it refuses: ``set -C; echo x >> a > a``
    leaves ``a`` existing and empty, and ``>| a > a`` truncates it. Only
    targets the scan found absent, or opened for truncation, are listed,
    so an append onto an existing file keeps its bytes.

    An earlier open that fails is the statement's refusal instead: bash
    stops at the first open it cannot perform, so ``echo x > /nodir/f >
    reg/`` reports ``/nodir/f: No such file or directory`` and never
    reaches the slashed target, and the opens after the failed one are
    not performed either.

    Args:
        dispatch (DispatchFn): op dispatcher.
        pending (list[PathSpec]): targets to create or truncate, in the
            order they were opened.

    Returns:
        The earlier open's failure, or None when every open went through.
    """
    for scope in pending:
        try:
            await dispatch("write", scope, data=b"")
        except FS_ERRORS as exc:
            return _redirect_failure(scope, exc)
    return None


def _ensure_scope(target):
    if isinstance(target, PathSpec):
        return target
    if isinstance(target, str):
        return _to_scope(target)
    return _to_scope(str(target))
