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
from collections.abc import Callable
from itertools import groupby
from operator import itemgetter
from typing import Any

from mirage.context import reset_program_invocation, set_program_invocation
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io import IOResult
from mirage.io.async_line_iterator import SharedInput, share
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.shell.console import Channel
from mirage.shell.constants import (
    FD_BOTH,
    FD_CLOSE,
    FD_STDERR,
    FD_STDIN,
    FD_STDOUT,
)
from mirage.shell.descriptors import (
    Descriptor,
    FileDescription,
    FileInput,
    Inherited,
    bad_descriptor_line,
    unsupported_descriptor,
)
from mirage.shell.errors import ExitSignal
from mirage.shell.helpers import get_redirects
from mirage.shell.join import shell_join
from mirage.shell.types import NodeType as NT
from mirage.shell.types import Redirect, RedirectKind, TSNodeLike
from mirage.types import PathSpec
from mirage.workspace.executor.builtins.exec.constants import (
    CLOSED,
    EXEC_STREAM_FIELDS,
    EXEC_USAGE,
    OPEN_FOR_READ_WRITE,
    OPEN_FOR_READING,
    TO_STDERR,
    TO_STDIN,
    TO_STDOUT,
)
from mirage.workspace.executor.builtins.getopt import scan_options
from mirage.workspace.executor.builtins.scope import _to_scope
from mirage.workspace.executor.builtins.shared import builtin_error
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.executor.create import create_file, write_description
from mirage.workspace.executor.find_action_dispatch import program_head
from mirage.workspace.executor.statement import Written, record_status
from mirage.workspace.executor.traps import clear_traps
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)


async def handle_exec_command(
    args: list[str],
    session: SessionState,
    execute_fn: Callable[..., Any] | None = None,
    registry: MountRegistry | None = None,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """The `exec` builtin without redirects.

    Bare `exec` is a no-op that succeeds. `exec CMD ...` runs CMD as a
    program and ends the shell with its status, as bash replaces the
    shell with it: the rest of the scope (the line at top level, a
    subshell, a substitution, a nested shell) does not run, and the
    replaced shell's actions go with it, EXIT included. A head no
    program answers to (a builtin of the shell's own, a function,
    nothing) is `exec: NAME: not found`, which ends the shell with 127
    and runs its EXIT action, as bash's does. `-c` runs CMD with an empty
    environment; `-a` and `-l` name an argv[0] that mirage's programs do
    not read, and are refused. The redirect-only form (`exec > file`)
    never reaches here: it is a redirected statement, handled where
    redirects are applied.

    Args:
        args (list[str]): the words after `exec`.
        session (SessionState): shell session state.
        execute_fn (Callable[..., Any] | None): runs CMD as a line of
            the shell; None where nothing can run one.
        registry (MountRegistry | None): where the head is looked up.
        stdin (ByteSource | None): the shell's standard input, CMD's.
    """
    scan = scan_options(args, "acl")
    refused = next((f for f in scan.letters if f in "al"), None)
    if scan.bad is not None or refused is not None:
        err = (
            builtin_error("exec", f"{scan.bad}: invalid option")
            + encode_text(EXEC_USAGE)
            if scan.bad is not None
            else encode_text(f"mirage: exec: -{refused}: not supported\n")
        )
        return (
            None,
            IOResult(exit_code=2, stderr=err),
            ExecutionNode(command="exec", exit_code=2, stderr=err),
        )
    words = scan.operands
    if not words or execute_fn is None or registry is None:
        return None, IOResult(), ExecutionNode(command="exec", exit_code=0)
    head = words[0]
    missing, shadowed = await program_head(
        head, session, registry, session.cwd, None
    )
    if missing:
        raise ExitSignal(
            127, stderr=builtin_error("exec", f"{head}: not found")
        )
    line = ("command " if shadowed else "") + shell_join(words)
    clear_traps(session)
    token = set_program_invocation(session)
    try:
        io = await execute_fn(
            ("env -i " if "c" in scan.letters else "") + line,
            session_id=session.session_id,
            stdin=stdin,
        )
    finally:
        reset_program_invocation(token)
    stdout = await materialize(io.stdout) or b""
    stderr = await materialize(io.stderr) or b""
    replaced = ExitSignal(io.exit_code, stderr=stderr, stdout=stdout)
    replaced.replaced, replaced.unrouted = head, True
    raise replaced


async def install_exec_redirects(
    dispatch: DispatchFn,
    session: SessionState,
    redirects: list[Redirect],
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Point the shell's own streams at files for the rest of the shell.

    The redirect-only `exec` form: `exec > file` sends every later
    statement's stdout to `file`, `exec 2> file` its stderr, `exec <
    file` feeds its stdin, and `exec >> file` appends. `2>&1` and `>&2`
    copy one stream's current target onto the other, and `>&-` / `<&-`
    close one. The output file is opened (created, and truncated unless
    appending) now, as bash opens it at `exec` time, so `exec > f`
    leaves an empty `f` even if nothing is written afterwards. A target
    that cannot be opened is bash's shell-attributed error and leaves
    the redirects unchanged, every earlier one on the line included
    (`_roll_back`). Numbered descriptors use the same bindings and
    share open file descriptions when duplicated.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): shell session state.
        redirects (list[Redirect]): the expanded redirects.
        stdin (ByteSource | None): current input for duplication.
    """
    bad_fd = unsupported_descriptor(redirects)
    if bad_fd is not None:
        return _exec_failure(bad_descriptor_line(bad_fd))
    saved = {name: getattr(session, name) for name in EXEC_STREAM_FIELDS}
    saved["descriptors"] = dict(session.descriptors)
    err = await _install(dispatch, session, redirects, stdin)
    if err is None:
        return None, IOResult(), ExecutionNode(command="exec", exit_code=0)
    return await _roll_back(dispatch, session, saved, err)


async def _install(
    dispatch: DispatchFn,
    session: SessionState,
    redirects: list[Redirect],
    stdin: ByteSource | None,
) -> bytes | None:
    for redirect in redirects:
        error = await _install_descriptor(dispatch, session, redirect, stdin)
        if error is not None:
            return error
    return None


async def _install_descriptor(
    dispatch: DispatchFn,
    session: SessionState,
    redirect: Redirect,
    stdin: ByteSource | None,
) -> bytes | None:
    fd = redirect.fd
    target = redirect.target
    if redirect.kind == RedirectKind.AMBIGUOUS:
        word = target.raw_path if isinstance(target, PathSpec) else str(target)
        return encode_text(f"{word}: ambiguous redirect\n")
    if redirect.kind in (RedirectKind.HEREDOC, RedirectKind.HERESTRING):
        text = str(target) + (
            "\n" if redirect.kind == RedirectKind.HERESTRING else ""
        )
        _bind(
            session,
            fd,
            OPEN_FOR_READING,
            False,
            SharedInput(encode_text(text)),
        )
        return None
    if isinstance(target, int):
        if target == fd:
            return None
        identity, append = (
            (CLOSED, False)
            if target == FD_CLOSE
            else _identity(session, target)
        )
        if identity == CLOSED and target != FD_CLOSE:
            return bad_descriptor_line(target)
        # Copies share the open description, including its offset, and
        # one of the terminal's streams stays that stream when the shell
        # later rebinds its own (`exec 3>&1; exec >f`).
        source = _read_end(session, target, stdin)
        original = session.descriptors.get(target)
        stream = original.stream if original is not None else None
        if (
            stream is None
            and fd > FD_STDERR
            and (original is None or original.file is None)
            and identity in (TO_STDOUT, TO_STDERR)
        ):
            stream = Inherited(
                session.terminal,
                Channel.STDOUT if identity == TO_STDOUT else Channel.STDERR,
            )
        _bind(
            session,
            fd,
            identity,
            append,
            source,
            original.file if original is not None else None,
            stream,
        )
        return None
    scope = _to_scope(target) if isinstance(target, str) else target
    try:
        if redirect.kind in (RedirectKind.STDIN, RedirectKind.READWRITE):
            try:
                data, _ = await dispatch("read", scope)
            except FileNotFoundError:
                if redirect.kind != RedirectKind.READWRITE:
                    raise
                data = b""
            if redirect.kind == RedirectKind.READWRITE:
                await create_file(dispatch, session, scope, b"", append=True)
                file = FileDescription(scope, opened=True)
                file.source = FileInput(file, await materialize(data) or b"")
                _bind(
                    session,
                    fd,
                    OPEN_FOR_READ_WRITE + scope.virtual,
                    False,
                    file.source,
                )
            else:
                _bind(
                    session,
                    fd,
                    OPEN_FOR_READING + scope.virtual,
                    False,
                    SharedInput(await materialize(data) or b""),
                )
        else:
            # Opened now, as bash opens it at `exec` time: truncating
            # creates the file empty, appending only when it is not there,
            # so `exec >> new; test -e new` succeeds with nothing written.
            await create_file(
                dispatch, session, scope, b"", append=redirect.append
            )
            file = FileDescription(scope, append=redirect.append, opened=True)
            for claimed in [1, 2] if fd == FD_BOTH else [fd]:
                _bind(
                    session, claimed, scope.virtual, redirect.append, file=file
                )
    except FS_ERRORS as exc:
        return _error_line(scope.raw_path, exc)
    return None


async def _roll_back(
    dispatch: DispatchFn,
    session: SessionState,
    saved: dict[str, str | bytes | bool | None],
    err: bytes,
) -> tuple[bytes | None, IOResult, ExecutionNode]:
    """Undo a redirect list that failed part-way, the way bash does.

    bash keeps the side effect of opening each earlier target (`exec
    >f </missing` leaves an empty `f`) but puts every descriptor back
    where it stood before the line, so an `echo` after it still reaches
    the terminal. The diagnostic itself goes through the descriptors as
    they stood at the failure, which is why `exec 2>e </missing` writes
    it into `e` and `exec 2>&1 </missing` prints it on stdout.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): shell session state.
        saved (dict[str, str | bytes | bool | None]): the stream fields
            as they stood before the line.
        err (bytes): the diagnostic of the redirect that failed.
    """
    partial = session.exec_stderr
    for name, value in saved.items():
        setattr(session, name, value)
    out, err_bytes, _ = await _route(
        dispatch, session, partial, err, TO_STDERR
    )
    return _exec_failure(err_bytes, out)


def _error_line(label: str, exc: OSError) -> bytes:
    """bash's line for a redirect target it could not open.

    Args:
        label (str): the target as typed.
        exc (OSError): what the dispatcher raised.
    """
    strerror = fs_strerror(exc)
    return encode_text(f"{label}: {strerror}\n" if strerror else f"{label}\n")


def _exec_failure(
    err: bytes | None,
    out: bytes | None = None,
) -> tuple[bytes | None, IOResult, ExecutionNode]:
    """The shell-attributed refusal of an `exec` redirect line.

    Args:
        err (bytes | None): the diagnostic, already in the shell's
            voice, or None once it was written where the line's own
            stderr redirect pointed.
        out (bytes | None): the diagnostic again, when that redirect
            pointed at the terminal's stdout.
    """
    return (
        out,
        IOResult(exit_code=1, stderr=err),
        ExecutionNode(command="exec", exit_code=1, stderr=err or b""),
    )


def _identity(session: SessionState, fd: int) -> tuple[str, bool]:
    """What a descriptor points at right now, named so a dup can copy it.

    A path with its append flag, `CLOSED`, a file's read end
    (`OPEN_FOR_READING` then the path), or one of the terminal's own
    streams (`&0`, `&1`, `&2`). The terminal streams are named
    rather than left as None because a dup copies the *target*, not
    the role: after `exec 1>&2`, fd 1 is the terminal's stderr whatever
    fd 2 is later pointed at, and `exec 2>&1` after that puts stderr
    back on the terminal's stderr, as bash does. Stdin is always the
    read end, so a stream bound to it (`exec 1>&0`) has nowhere to
    write.

    Args:
        session (SessionState): shell session state.
        fd (int): the descriptor being copied.
    """
    if fd > FD_STDERR:
        descriptor = session.descriptors.get(fd)
        return (
            (descriptor.identity, descriptor.append)
            if descriptor
            else (CLOSED, False)
        )
    if fd == FD_STDIN:
        # fd 0 is its own read end unless an `exec` rebound it: closed,
        # or a writing stream's identity (`exec 0<&1`), which a later dup
        # from fd 0 copies as bash's does.
        identity = session.exec_stdin_identity
        return (TO_STDIN if identity is None else identity), False
    if fd == FD_STDERR:
        return (
            TO_STDERR if session.exec_stderr is None else session.exec_stderr,
            session.exec_stderr_append,
        )
    return (
        TO_STDOUT if session.exec_stdout is None else session.exec_stdout,
        session.exec_stdout_append,
    )


def _read_end(
    session: SessionState, fd: int, stdin: ByteSource | None = None
) -> SharedInput | None:
    """A new descriptor on the read end a descriptor holds, as a dup
    makes one: it shares the offset, so a read through either moves
    both. None when the descriptor holds no file's read end.

    Args:
        session (SessionState): shell session state.
        fd (int): the descriptor being copied.
    """
    if fd == FD_STDIN and stdin is not None:
        source = share(stdin)
        return source if isinstance(source, SharedInput) else None
    if fd > FD_STDERR:
        descriptor = session.descriptors.get(fd)
        return descriptor.source if descriptor else None
    held = (
        session.exec_stdin
        if fd == FD_STDIN
        else session.exec_stderr_input
        if fd == FD_STDERR
        else session.exec_stdout_input
    )
    return held.dup() if held is not None else None


def _bind(
    session: SessionState,
    fd: int,
    identity: str,
    append: bool,
    read_end: SharedInput | None = None,
    file: FileDescription | None = None,
    stream: Inherited | None = None,
) -> None:
    """Point a writing stream at an identity.

    A stream on its own terminal end is stored as None, the undiverted
    state every reader of `exec_stdout`/`exec_stderr` already knows.

    Args:
        session (SessionState): shell session state.
        fd (int): the descriptor being bound, 1 or 2.
        identity (str): what `_identity` named, or `CLOSED`.
        append (bool): whether writes append, for a path.
        read_end (SharedInput | None): the file's read end, for an
            `OPEN_FOR_READING` identity.
        file (FileDescription | None): the open file it shares.
        stream (Inherited | None): the terminal stream it copies.
    """
    session.descriptors[fd] = Descriptor(
        identity,
        append,
        read_end,
        read_end.description if isinstance(read_end, FileInput) else file,
        stream,
    )
    if fd > FD_STDERR:
        return
    if fd == FD_STDIN:
        session.exec_stdin = read_end
        session.exec_stdin_identity = (
            None if identity == TO_STDIN else identity
        )
        session.exec_stdin_unreadable = (
            read_end is None and identity != TO_STDIN
        )
    elif fd == FD_STDERR:
        session.exec_stderr = None if identity == TO_STDERR else identity
        session.exec_stderr_append = append
        session.exec_stderr_input = read_end
    else:
        session.exec_stdout = None if identity == TO_STDOUT else identity
        session.exec_stdout_append = append
        session.exec_stdout_input = read_end


async def _route(
    dispatch: DispatchFn,
    session: SessionState,
    binding: str | None,
    data: bytes,
    own: str,
) -> tuple[bytes | None, bytes | None, bool]:
    """Deliver one stream's bytes where its binding points.

    To the terminal's stdout, to the terminal's stderr, into a file, or
    nowhere. Returns the bytes for each terminal stream and whether the
    write failed: a stream bound to stdin (`exec 1>&0`) or to a file's
    read end (`exec 1<f`) cannot be written, which is bash's
    `write error: Bad file descriptor`.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): shell session state.
        binding (str | None): the stream's `exec` binding.
        data (bytes): what the statement wrote on it.
        own (str): the stream's own terminal end, used when undiverted.
    """
    target = own if binding is None else binding
    descriptor = session.descriptors.get(1 if own == TO_STDOUT else 2)
    if (
        descriptor is not None
        and descriptor.file is not None
        and descriptor.identity == target
    ):
        await write_description(dispatch, session, descriptor.file, data)
        return None, None, False
    if target.startswith(OPEN_FOR_READ_WRITE):
        source = (
            session.exec_stdout_input
            if own == TO_STDOUT
            else session.exec_stderr_input
        )
        if isinstance(source, FileInput):
            await write_description(
                dispatch, session, source.description, data
            )
            return None, None, False
    if target == TO_STDOUT:
        return data, None, False
    if target == TO_STDERR:
        return None, data, False
    if target == TO_STDIN or target.startswith(OPEN_FOR_READING):
        return None, None, True
    if target != CLOSED:
        await _append(dispatch, session, target, data)
    return None, None, False


def _stdout_to_stderr(node: TSNodeLike) -> bool:
    """Whether a statement sends its own stdout to stderr (``>&2``).

    What tells a writer's failed write from a lost diagnostic under an
    unwritable stderr: bash's ``echo hi >&2`` reports 1 when the write
    fails, while a program whose diagnostic could not be delivered keeps
    its own status.

    Args:
        node (TSNodeLike): the statement's tree-sitter node.
    """
    if node.type != NT.REDIRECTED_STATEMENT:
        return False
    _, redirects = get_redirects(node)
    return any(
        isinstance(r.target, int)
        and r.target == FD_STDERR
        and r.fd in (FD_STDOUT, FD_BOTH)
        for r in redirects
    )


async def divert_statement(
    dispatch: DispatchFn | None,
    session: SessionState,
    written: list[Written],
    io: IOResult,
    statement: TSNodeLike,
    command: str,
) -> list[Written]:
    """Send one statement's output where the shell's `exec` bindings point.

    Called after each statement of a shell's own loop; with no `exec`
    redirect in force the output passes through. A stream bound to a
    file is appended to it (the first write to each target having
    truncated it at `exec` time), one bound to the other terminal
    stream crosses over (`exec 2>&1` puts stderr on stdout), a closed
    one is dropped, and one bound to stdin fails with bash's `write
    error: Bad file descriptor`, which is reported on stderr through
    stderr's own binding and makes the statement's status 1, which `$?`
    shows. An unwritable stderr fails only a statement that sent its own
    stdout there (``>&2``); a lost diagnostic leaves the status the
    command earned. Returns what is left for the terminal, in the order
    it was written.

    Args:
        dispatch (DispatchFn | None): op dispatcher, None for a loop
            that diverts nothing.
        session (SessionState): shell session state.
        written (list[Written]): the statement's output in order; what
            went to the terminal through a copy keeps its place.
        io (IOResult): the statement's result; its exit status is
            amended in place.
        statement (TSNodeLike): the statement that wrote it.
        command (str): the statement's recorded line; its first word
            names the writer in a write error.
    """
    if dispatch is None or (
        session.exec_stdout is None and session.exec_stderr is None
    ):
        return written
    earned = io.exit_code
    rest: list[Written] = []
    failed = unwritable = False
    for (channel, kept), run in groupby(written, key=itemgetter(0, 2)):
        data = b"".join(chunk[1] for chunk in run)
        if kept:
            rest.append((channel, data, True))
        elif await _routed(dispatch, session, channel, data, rest):
            failed = failed or channel == Channel.STDOUT
            unwritable = unwritable or channel == Channel.STDERR
    if failed:
        words = command.split()
        line = encode_text(
            f"{words[0] if words else 'bash'}: write error: "
            "Bad file descriptor\n"
        )
        io.exit_code = 1
        await _routed(dispatch, session, Channel.STDERR, line, rest)
    elif unwritable and io.exit_code == 0 and _stdout_to_stderr(statement):
        # The statement's own output was what could not be written, so
        # the write error is its failure (bash's `echo hi >&2` under
        # `exec 2>&0` reports 1). A diagnostic that could not be
        # delivered leaves the status alone: GNU find still exits 0
        # after `-exec nosuch`, ls keeps its 2 and cat its 1, since the
        # failed write is of a message, not of the work.
        io.exit_code = 1
    if io.exit_code != earned:
        record_status(session, io.exit_code)
    return rest


async def _routed(
    dispatch: DispatchFn,
    session: SessionState,
    channel: Channel,
    data: bytes,
    rest: list[Written],
) -> bool:
    """Route one run of output through its stream's binding, adding what
    reaches the terminal to ``rest``; True when the write failed.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): shell session state.
        channel (Channel): the stream the statement wrote on.
        data (bytes): the bytes, in the order they were written.
        rest (list[Written]): what is left for the terminal so far.
    """
    stdout = channel == Channel.STDOUT
    out, err, failed = await _route(
        dispatch,
        session,
        session.exec_stdout if stdout else session.exec_stderr,
        data,
        TO_STDOUT if stdout else TO_STDERR,
    )
    rest.extend(
        (stream, part, False)
        for stream, part in ((Channel.STDOUT, out), (Channel.STDERR, err))
        if part
    )
    return failed


async def _append(
    dispatch: DispatchFn, session: SessionState, target: str, data: bytes
) -> None:
    """Append bytes to an `exec` target, or drop them if it is closed.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): shell session state.
        target (str): the target path, or `""` for a closed stream.
        data (bytes): the bytes to write.
    """
    if target == CLOSED:
        return
    scope = _to_scope(target)
    try:
        await dispatch("append", scope, data=data)
    except FS_ERRORS as exc:
        logger.debug("exec write failed for %s: %s", target, exc)


async def exec_builtin(call: BuiltinCall) -> Result:
    """The ``exec`` arm.

    The redirect-only form is intercepted where redirects are applied;
    a bare ``exec`` reaching here has no redirects, and ``exec cmd`` is
    the form that runs the command and ends the shell.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_exec_command(
        list(call.argv.args),
        call.context.session,
        call.execute_fn,
        call.registry,
        call.stdin,
    )
