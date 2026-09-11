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

import tree_sitter

from mirage.commands.spec.usage import read_fail_exit
from mirage.context import reset_redirect_paths, set_redirect_paths
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.constants import (FD_BOTH, FD_CLOSE, FD_STDERR, FD_STDIN,
                                    FD_STDOUT)
from mirage.shell.descriptors import (bad_descriptor_line, unreadable_stdin,
                                      unsupported_descriptor)
from mirage.shell.helpers import get_text
from mirage.shell.types import Redirect, RedirectKind
from mirage.types import FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, format_fs_error, fs_strerror
from mirage.workspace.executor.builtins import _to_scope
from mirage.workspace.executor.builtins.exec.constants import (
    CLOSED, OPEN_FOR_READING, TO_STDERR, TO_STDIN, TO_STDOUT)
from mirage.workspace.executor.builtins.exec.exec import read_open_source
from mirage.workspace.executor.create import create_file
from mirage.workspace.session import Session
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


def _persistently_closed(session: Session) -> set[int]:
    """The descriptors an ``exec`` closed for the shell, which a line's
    dup from refuses before the command runs.

    Args:
        session (Session): shell session state.
    """
    closed: set[int] = set()
    if session.exec_stdin_identity == CLOSED:
        closed.add(FD_STDIN)
    if session.exec_stdout == CLOSED:
        closed.add(FD_STDOUT)
    if session.exec_stderr == CLOSED:
        closed.add(FD_STDERR)
    return closed


def _stdin_dest(session: Session) -> _Fd | str:
    """Where a write through fd 0 lands, read off the shell's bindings.

    Its own read end, a closed descriptor and a file's read end take
    no write (`echo x >&0` is bash's `write error: Bad file descriptor`
    with stdin a pipe); a terminal stream dup'd onto it (`exec 0<&1`)
    writes where that stream goes; a file opened for writing
    (`exec 0>f`) is the file.

    Args:
        session (Session): shell session state.
    """
    identity = session.exec_stdin_identity
    if (identity is None or identity == CLOSED
            or identity.startswith(OPEN_FOR_READING)):
        return _CLOSED
    if identity == TO_STDOUT:
        return _TO_STDOUT
    if identity == TO_STDERR:
        return _TO_STDERR
    return identity


async def handle_redirect(
    execute_node,
    dispatch,
    command: tree_sitter.Node | None,
    redirects: list[Redirect],
    session: Session,
    stdin: ByteSource | None = None,
    call_stack: CallStack | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Handle all redirect patterns: >, >>, <, 2>, 2>&1, &>, >&2, <<<.

    File-descriptor routing follows bash's left-to-right fd table:
    each redirect updates where fd1/fd2 point at that moment, so
    `cmd > f 2>&1` sends both streams to f while `cmd 2>&1 > f`
    sends stderr to the original stdout. Output files are created (and
    truncated unless appending) when the redirect is processed, even
    if the stream ends up empty — including the command-less
    `> file` form (command is None).

    A redirect naming a descriptor above 2 is refused before anything
    opens, in bash's own words for a descriptor that is not open
    (``3: Bad file descriptor``, exit 1, the command never runs and the
    rest of the line goes on). bash would open ``3>f`` itself; mirage
    models no descriptor table, so claiming fd 3 and duplicating from
    it are refused alike rather than silently aliased onto stdout.
    ``>&-`` closes a stream for the command: its stdout is dropped and,
    if it wrote any, ``<cmd>: write error: Bad file descriptor`` exits
    1; a closed stdin reads as empty, a documented approximation of
    EBADF.

    A redirect target that cannot be opened is a shell error, not a
    command error — on both the ``<`` read and the ``>`` write side.
    bash reports it itself and never names the command, so both paths
    render ``<target>: <strerror>`` (see ``_redirect_error_line``) and
    the rest of the line keeps running. bash also stops processing
    redirects at the first failed open, so later targets are left
    alone: GNU 5.2.37 answers ``echo x > /nodir/f > /data/out`` with one
    message and no ``/data/out``, while earlier targets keep the empty
    file their open already created (``echo y > /data/out2 > /nodir/g``
    leaves ``/data/out2`` present and empty).

    Deliberate divergence from bash: when both streams route to the
    same destination they are concatenated stdout-then-stderr, not
    temporally interleaved (streams are materialized buffers).

    Deliberate divergence from bash: because output files are created
    in a second pass (after the command runs), an output redirect that
    precedes a failing ``<`` is not truncated — bash processes
    redirects strictly left to right, so ``> out < missing`` empties
    ``out`` before failing. ``< missing > out`` leaves ``out``
    uncreated on both, which is bash's behavior. For the same reason a
    command whose ``>`` target is unwritable has already run here,
    while bash fails at open time and never runs it; the write error
    and exit 1 are reported either way.
    """
    for r in redirects:
        if r.kind == RedirectKind.AMBIGUOUS:
            # bash's word: `3>&foo` is refused before any descriptor is
            # judged or any file opened, and the command never runs.
            return _shell_failure(
                f"{_redirect_word(r)}: ambiguous redirect\n".encode())
    bad_fd = unsupported_descriptor(redirects)
    if bad_fd is not None:
        return _shell_failure(bad_descriptor_line(bad_fd))
    # What each descriptor would yield to a read: stdin as given, and
    # the two output descriptors nothing, since they are open for
    # writing only. A dup copies the entry, so `1<&0 0<&1` hands stdin's
    # file back to stdin while `0<&1` alone leaves stdin unreadable, and
    # a closed descriptor is unreadable too. The command sees the
    # unreadable entry as a source that fails on its first read, as in
    # bash (`cat 0<&1`, `cat <&-`), while one that never reads is
    # untouched (`true 0<&1`).
    inputs: list[ByteSource | None | _Unreadable] = [
        stdin, _Unreadable.TOKEN, _Unreadable.TOKEN
    ]
    # A stream `exec 1<f` opened for reading answers a read through it
    # (`cat <&1`) with the file, from its start, and one `exec 1<&0`
    # aliased onto stdin's own read end reads what stdin reads.
    for fd, binding in ((FD_STDOUT, session.exec_stdout),
                        (FD_STDERR, session.exec_stderr)):
        if binding is not None and binding.startswith(OPEN_FOR_READING):
            inputs[fd] = await read_open_source(dispatch, binding)
        elif binding == TO_STDIN:
            inputs[fd] = inputs[FD_STDIN]
    # A descriptor an earlier redirect closed, or an `exec` closed for
    # the shell, is not merely write-only: a later dup from it is bash's
    # `0: Bad file descriptor`, and the command never runs (`touch
    # marker 0<&- 1<&0` and `exec 1>&-; touch marker 2>&1` create
    # nothing). A dup of a closed descriptor onto itself stays the no-op
    # it is, and a redirect that opens or dups onto the descriptor
    # takes it out of the set again.
    closed = _persistently_closed(session)
    for r in redirects:
        if isinstance(r.target, int):
            if r.target == FD_CLOSE:
                closed.add(r.fd)
                inputs[r.fd] = _Unreadable.TOKEN
                continue
            if r.target == r.fd:
                # A self-dup changes nothing: a closed descriptor stays
                # closed, so `touch m 1>&- 1>&1 2>&1` is still refused.
                continue
            if r.target in closed:
                return _shell_failure(bad_descriptor_line(r.target))
            inputs[r.fd] = inputs[r.target]
            closed.discard(r.fd)
            continue
        for fd in ([FD_STDOUT, FD_STDERR] if r.fd == FD_BOTH else [r.fd]):
            closed.discard(fd)
        if r.kind == RedirectKind.STDIN:
            scope = _ensure_scope(r.target)
            try:
                file_data, _ = await dispatch("read", scope)
            except FS_ERRORS as exc:
                return _redirect_failure(scope, exc)
            inputs[r.fd] = file_data
        elif r.kind == RedirectKind.HEREDOC:
            inputs[r.fd] = encode_text(r.target) if isinstance(
                r.target, str) else r.target
        elif r.kind == RedirectKind.HERESTRING:
            text = r.target
            if isinstance(text, str):
                if text.startswith('"') and text.endswith('"'):
                    text = text[1:-1]
                elif text.startswith("'") and text.endswith("'"):
                    text = text[1:-1]
                inputs[r.fd] = encode_text(text + "\n")
            else:
                inputs[r.fd] = text

        else:
            # An output redirect opens its target for writing only, so
            # the descriptor stays unreadable: `cat 1>out 0<&1` reads
            # from out's write end and fails with EBADF, as bash's does.
            for fd in ([FD_STDOUT, FD_STDERR] if r.fd == FD_BOTH else [r.fd]):
                inputs[fd] = _Unreadable.TOKEN

    # Before the command, because bash decides an open before it forks:
    # `set -C; touch marker > existing` creates no marker at all. Running
    # first and discarding the output afterwards matched the file
    # contents and nothing else, so a refused redirect still let `rm`
    # delete its own target -- and then the probe found nothing there
    # and did not even refuse.
    refusal = await _noclobber_refusal(dispatch, session, redirects)
    if refusal is not None:
        return refusal

    refused = False
    if command is None:
        stdout_data = b""
        stderr_data = b""
        io = IOResult(exit_code=0)
    else:
        # The expanded targets ride to the command's admission gate: the
        # reads and writes below run on the shell's own fds outside the
        # admitted command's gate window, so the gate must judge the
        # targets with the line. Bound to this node's id so a nested
        # line expanded on the way never inherits them.
        targets = tuple(
            _ensure_scope(r.target) for r in redirects
            if r.kind not in (RedirectKind.HEREDOC, RedirectKind.HERESTRING)
            and not isinstance(r.target, int))
        token = set_redirect_paths(command.id, targets)
        try:
            command_stdin = inputs[FD_STDIN]
            stdout, io, exec_node = await execute_node(
                command, session,
                unreadable_stdin() if isinstance(command_stdin, _Unreadable)
                else command_stdin, call_stack)
        finally:
            reset_redirect_paths(token)
        refused = exec_node.refused
        try:
            barriered = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
            if isinstance(barriered, memoryview):
                barriered = bytes(barriered)
            stdout_data = await materialize(barriered) or b""
        except FS_ERRORS as exc:
            # stdin bound to a closed or write-only descriptor fails
            # only once the command reads it, which is this drain; that
            # is the command's failure in its own voice (`cat: -: Bad
            # file descriptor`), and the line goes on.
            name = exec_node.command.split()[0] if exec_node.command else ""
            stdout_data = b""
            io.stderr = ((await materialize(io.stderr) or b"") +
                         format_fs_error(name, exc, exec_node.paths))
            io.exit_code = read_fail_exit(name, exc)
        stderr_data = await materialize(io.stderr) or b""

    fds: list[_Fd | str] = [_stdin_dest(session), _TO_STDOUT, _TO_STDERR]
    file_bufs: dict[str, bytearray] = {}
    file_scopes: dict[str, PathSpec] = {}

    for r in redirects:
        if isinstance(r.target, int):
            dest = _CLOSED if r.target == FD_CLOSE else fds[r.target]
            fds[r.fd] = dest
            if isinstance(dest, str) and dest not in file_bufs and not refused:
                # fd 0 holds a file's write end (`exec 0>f`), which
                # `exec` truncated when it opened it, so a dup from it
                # appends, as writes through bash's shared offset do.
                scope = _ensure_scope(dest)
                file_scopes[dest] = scope
                file_bufs[dest] = bytearray(await
                                            _read_existing(dispatch, scope))
            continue

        if r.kind in (RedirectKind.STDIN, RedirectKind.HEREDOC,
                      RedirectKind.HERESTRING):
            fds[r.fd] = _CLOSED
            continue

        if refused:
            # The gate refused the line, so it performs no file I/O: the
            # target is neither created nor truncated (bash's
            # open-before-exec would; a policy refusal must leave the
            # protected file alone), and the refusal flows to the caller
            # on the shell's own streams, which the fd dups above still
            # route (`cmd 2>&1` reads as bash routes it).
            continue

        scope = _ensure_scope(r.target)
        path = scope.virtual
        file_scopes[path] = scope
        if r.append:
            if path not in file_bufs:
                file_bufs[path] = bytearray(await
                                            _read_existing(dispatch, scope))
        else:
            file_bufs[path] = bytearray()

        if r.fd == FD_BOTH:
            fds[FD_STDOUT] = path
            fds[FD_STDERR] = path
        else:
            fds[r.fd] = path

    if fds[FD_STDOUT] is _CLOSED and stdout_data and command is not None:
        stderr_data += _closed_write_line(command)
        io.exit_code = 1
    out_stdout = bytearray()
    out_stderr = bytearray()
    for data, dest in ((stdout_data, fds[FD_STDOUT]), (stderr_data,
                                                       fds[FD_STDERR])):
        if dest is _TO_STDOUT:
            out_stdout += data
        elif dest is _TO_STDERR:
            out_stderr += data
        elif isinstance(dest, str):
            file_bufs[dest] += data

    # Bound again for the writes, because the admission that judged
    # these targets ended with the command and the op doors below see
    # them from underneath: with no line and no grant behind it, a door
    # re-deriving a verdict here would refuse the very carve-out the
    # command was admitted under. Only a redirect that had a command has
    # been judged at all, so the bare ``> file`` form binds nothing and
    # is judged by the door on its own.
    write_token = (set_redirect_paths(command.id, tuple(file_scopes.values()))
                   if command is not None else None)
    try:
        for path, buf in file_bufs.items():
            data = bytes(buf)
            scope = file_scopes[path]
            try:
                await create_file(dispatch, session, scope, data)
            except FS_ERRORS as exc:
                out_stderr += _redirect_error_line(scope, exc)
                io.exit_code = 1
                break
            io.writes[path] = data
    finally:
        if write_token is not None:
            reset_redirect_paths(write_token)

    result_stdout = bytes(out_stdout)
    io.stderr = bytes(out_stderr) if out_stderr else None
    exec_node = ExecutionNode(command="redirect",
                              exit_code=io.exit_code,
                              refused=refused)
    return result_stdout if result_stdout else None, io, exec_node


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
    one-line ``Workspace.execute`` call.

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


def _closed_write_line(command: tree_sitter.Node) -> bytes:
    """GNU's line for a write onto a closed stdout, in the command's name.

    Args:
        command (tree_sitter.Node): the command whose stdout was closed.
    """
    words = get_text(command).split()
    name = words[0] if words else "redirect"
    return f"{name}: write error: Bad file descriptor\n".encode()


def _redirect_word(r: Redirect) -> str:
    """The redirect's target as typed, for a refusal that names it.

    Args:
        r (Redirect): the redirect, its target expanded or not.
    """
    return r.target.raw_path if isinstance(r.target, PathSpec) else str(
        r.target)


def _redirect_failure(scope: PathSpec,
                      exc: OSError) -> tuple[None, IOResult, ExecutionNode]:
    """Shell-attributed IOResult for a ``<`` source that cannot be read.

    Args:
        scope (PathSpec): The redirect source that could not be read.
        exc (OSError): The filesystem error raised by the read.
    """
    return _shell_failure(_redirect_error_line(scope, exc))


def _shell_failure(line: bytes) -> tuple[None, IOResult, ExecutionNode]:
    """Shell-attributed IOResult that replaces the command's whole run.

    bash never runs the command and stops processing redirects at the
    first failure, so this replaces the whole result. Returning an
    IOResult rather than letting the error propagate is what keeps the
    rest of the line alive; it also stops the workspace-level ``OSError``
    handler from stamping the line's first word onto the message
    (``cd /data && cat < missing`` used to report ``cd:``).

    Args:
        line (bytes): the diagnostic, already in the shell's voice.
    """
    io = IOResult(exit_code=1, stderr=line)
    return None, io, ExecutionNode(command="redirect", exit_code=1)


async def _noclobber_refusal(
    dispatch: DispatchFn,
    session: Session,
    redirects: list[Redirect],
) -> tuple[None, IOResult, ExecutionNode] | None:
    """Refuse the whole statement when `set -C` bars one of its opens.

    Returned *instead of* running the command, because that is what bash
    does: it opens every redirect before it forks, so a refusal means
    the command never runs. `set -C; touch marker > existing` leaves no
    marker behind. Deciding this after the fact only matched the file
    contents, and on `rm f > f` it did not even do that -- the command
    deleted its own target first, so the probe found nothing there and
    let the line succeed.

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

    The whole scan is skipped unless the option is on, so the ordinary
    redirect path costs no extra round trip. That leaves
    `> <a directory>` with the option off silently succeeding, which is
    a separate pre-existing gap: GNU answers `Is a directory` and exit 1
    whichever operator asked, and closing it means a stat on every
    output redirect.

    Targets are stat'd through the op dispatcher rather than a backend,
    so a redirect that lands on another mount is answered by the mount
    that owns it.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (Session): the session holding the shell options.
        redirects (list[Redirect]): the statement's redirects, in the
            order they were written.

    Returns:
        The refusal result, or None when every open is allowed.
    """
    if not session.shell_options.get("noclobber"):
        return None
    opened: set[str] = set()
    pending: list[PathSpec] = []
    for r in redirects:
        if (r.kind in (RedirectKind.STDIN, RedirectKind.HEREDOC,
                       RedirectKind.HERESTRING) or isinstance(r.target, int)):
            continue
        scope = _ensure_scope(r.target)
        path = scope.virtual
        is_dir = False
        if path in opened:
            exists = True
        else:
            try:
                stat, _ = await dispatch("stat", scope)
            except FS_ERRORS as exc:
                logger.debug("noclobber probe found no target at %s: %s",
                             scope.raw_path, exc)
                stat = None
            exists = stat is not None
            is_dir = stat is not None and stat.type == FileType.DIRECTORY
        if exists and not r.append and not r.clobber:
            await _apply_pending_opens(dispatch, pending)
            detail = ("Is a directory"
                      if is_dir else "cannot overwrite existing file")
            err = f"{scope.raw_path}: {detail}\n".encode()
            io = IOResult(exit_code=1, stderr=err)
            return None, io, ExecutionNode(command="redirect", exit_code=1)
        # This open succeeds, so the target exists for every redirect
        # after it, and a truncating one leaves it empty to be found.
        opened.add(path)
        if not exists or not r.append:
            pending.append(scope)
    return None


async def _apply_pending_opens(dispatch: DispatchFn,
                               pending: list[PathSpec]) -> None:
    """Apply the opens a refused statement already performed.

    bash opens redirects left to right, so the ones before the refused
    one have happened by the time it refuses: ``set -C; echo x >> a > a``
    leaves ``a`` existing and empty, and ``>| a > a`` truncates it. Only
    targets the scan found absent, or opened for truncation, are listed,
    so an append onto an existing file keeps its bytes.

    A write that fails is logged rather than raised: the failure belongs
    to that earlier redirect, which bash would have reported instead of
    the noclobber refusal, and inventing that error here would replace
    the refusal the caller is about to return.

    Args:
        dispatch (DispatchFn): op dispatcher.
        pending (list[PathSpec]): targets to create or truncate, in the
            order they were opened.
    """
    for scope in pending:
        try:
            await dispatch("write", scope, data=b"")
        except FS_ERRORS as exc:
            logger.debug("noclobber pre-open write failed for %s: %s",
                         scope.raw_path, exc)


async def _read_existing(dispatch, scope) -> bytes:
    try:
        existing, _ = await dispatch("read", scope)
        if isinstance(existing, bytes):
            return existing
    except FS_ERRORS as exc:
        # appending starts from empty when the target is missing or
        # unreadable; the write that follows reports the real failure as
        # a shell-attributed line. Narrower than FS_ERRORS would let a
        # PermissionError escape to the workspace-level OSError handler,
        # which kills the rest of the line and misattributes the message.
        logger.debug("append pre-read failed for %s: %s", scope.raw_path, exc)
    return b""


def _ensure_scope(target):
    if isinstance(target, PathSpec):
        return target
    if isinstance(target, str):
        return _to_scope(target)
    return _to_scope(str(target))
