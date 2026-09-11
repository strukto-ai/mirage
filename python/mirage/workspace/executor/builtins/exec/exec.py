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
from typing import Any

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.constants import (FD_BOTH, FD_CLOSE, FD_STDERR, FD_STDIN,
                                    FD_STDOUT)
from mirage.shell.descriptors import (bad_descriptor_line,
                                      unsupported_descriptor)
from mirage.shell.helpers import get_redirects
from mirage.shell.types import NodeType as NT
from mirage.shell.types import Redirect, RedirectKind
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_strerror
from mirage.workspace.executor.builtins.exec.constants import (
    CLOSED, EXEC_STREAM_FIELDS, OPEN_FOR_READING, TO_STDERR, TO_STDIN,
    TO_STDOUT)
from mirage.workspace.executor.builtins.scope import _to_scope
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.executor.create import create_file
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)


async def handle_exec_command(
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """The `exec` builtin without redirects.

    Bare `exec` is a no-op that succeeds. `exec CMD ...` asks the shell
    to replace itself with a program, which has no referent here (the
    in-process shell is an async executor, not an OS process: no PID,
    no `execve`), so it is refused loudly rather than run-then-exit,
    which would look like success while meaning something else. The
    redirect-only form (`exec > file`) never reaches here: it is a
    redirected statement, handled where redirects are applied.

    Args:
        args (list[str]): the words after `exec`.
        session (Session): shell session state.
    """
    if not args:
        return None, IOResult(), ExecutionNode(command="exec", exit_code=0)
    err = (f"mirage: exec: {args[0]}: process replacement is not supported "
           "(no OS process to replace)\n").encode()
    return None, IOResult(exit_code=2,
                          stderr=err), ExecutionNode(command="exec",
                                                     exit_code=2,
                                                     stderr=err)


async def install_exec_redirects(
    dispatch: DispatchFn,
    session: Session,
    redirects: list[Redirect],
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
    (`_roll_back`). So is a descriptor above 2 (`exec 3>f`,
    `exec 3>&-`): the shell has no descriptor table, so the line is
    refused with `3: Bad file descriptor` rather than aliased onto
    stdout, which is what `exec 3>&-` used to close.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (Session): shell session state.
        redirects (list[Redirect]): the expanded redirects.
    """
    bad_fd = unsupported_descriptor(redirects)
    if bad_fd is not None:
        return _exec_failure(bad_descriptor_line(bad_fd))
    saved = {name: getattr(session, name) for name in EXEC_STREAM_FIELDS}
    err = await _install(dispatch, session, redirects)
    if err is None:
        return None, IOResult(), ExecutionNode(command="exec", exit_code=0)
    return await _roll_back(dispatch, session, saved, err)


async def _install(dispatch: DispatchFn, session: Session,
                   redirects: list[Redirect]) -> bytes | None:
    """Bind the redirects onto the session's streams, in line order.

    Returns the diagnostic of the first redirect that fails, with every
    earlier one still bound, which is the state bash reports from.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (Session): shell session state.
        redirects (list[Redirect]): the expanded redirects.
    """
    for r in redirects:
        if r.kind == RedirectKind.AMBIGUOUS:
            word = (r.target.raw_path
                    if isinstance(r.target, PathSpec) else str(r.target))
            return f"{word}: ambiguous redirect\n".encode()
        if isinstance(r.target, int):
            # Keyed on the descriptor claimed, not the operator's
            # direction: `2<&-` closes stderr and `0>&-` stdin, as in
            # bash.
            if r.fd == FD_STDIN:
                # A closed stdin, or a writing stream dup'd onto it
                # (`0<&1`), has nothing to read: the next reader gets
                # EBADF, as bash's does, until `exec < file` binds a
                # file again. A dup of stdin onto itself keeps the file
                # an earlier `exec <f` bound, and so does a dup from a
                # descriptor that itself holds stdin's read end
                # (`exec 1<&0; exec 0<&1`), which bash reads from as
                # before. Not modelled: a stdin rebound between the two
                # dups, which bash's fd 1 would still hold the old end of.
                if r.target == FD_CLOSE:
                    session.exec_stdin = None
                    session.exec_stdin_unreadable = True
                    session.exec_stdin_identity = CLOSED
                    continue
                if r.target == FD_STDIN:
                    # A dup onto itself changes nothing, a closed
                    # descriptor's included (`exec 0<&-; exec 0<&0`).
                    continue
                source = _identity(session, r.target)[0]
                if source == CLOSED:
                    return bad_descriptor_line(r.target)
                if source == TO_STDIN:
                    session.exec_stdin_unreadable = False
                    session.exec_stdin_identity = None
                elif source.startswith(OPEN_FOR_READING):
                    # The descriptor holds a file's read end (`exec 1<f`):
                    # fd 0 takes the same end, read from the file's
                    # start, and a later dup from fd 0 copies it on.
                    session.exec_stdin = await read_open_source(
                        dispatch, source)
                    session.exec_stdin_unreadable = False
                    session.exec_stdin_identity = source
                else:
                    session.exec_stdin = None
                    session.exec_stdin_unreadable = True
                    session.exec_stdin_identity = source
                continue
            if r.target == FD_CLOSE:
                _bind(session, r.fd, CLOSED, False)
                continue
            if r.target == r.fd:
                # `exec 1>&1` on a closed fd 1 is bash's no-op too.
                continue
            identity, append = _identity(session, r.target)
            if identity == CLOSED:
                # A dup from a closed descriptor is refused, as bash's
                # `exec 0<&-; exec 1<&0` is with `0: Bad file descriptor`.
                return bad_descriptor_line(r.target)
            _bind(session, r.fd, identity, append)
            continue
        scope = _to_scope(r.target) if isinstance(r.target, str) else r.target
        if r.kind == RedirectKind.STDIN:
            try:
                data, _ = await dispatch("read", scope)
            except FS_ERRORS as exc:
                return _error_line(scope.raw_path, exc)
            if r.fd != FD_STDIN:
                # `exec 1<f`: the stream holds the file's read end, so a
                # write to it fails as one to stdin's end does
                # (`echo: write error: Bad file descriptor`), a dup onto
                # fd 0 (`exec 0<&1`) reads the file, and so does a
                # transient `<&1`.
                _bind(session, r.fd, OPEN_FOR_READING + scope.virtual, False)
                continue
            # fd 0 holds the file's read end, and says so: a dup from it
            # (`exec 1<&0`) keeps the file even after `exec 0<&-`, as
            # bash's copied descriptor does.
            session.exec_stdin = await materialize(data) or b""
            session.exec_stdin_unreadable = False
            session.exec_stdin_identity = OPEN_FOR_READING + scope.virtual
            continue
        path = scope.virtual
        try:
            if await _open_target(dispatch, session, scope, r.append):
                session._exec_opened.add(path)
        except FS_ERRORS as exc:
            return _error_line(scope.raw_path, exc)
        if r.fd == FD_STDIN:
            # `exec 0>f`: fd 0 holds the file's write end, so a read
            # fails with EBADF, a later dup from it (`exec 1>&0`) writes
            # there, and so does a transient `>&0`.
            session.exec_stdin = None
            session.exec_stdin_unreadable = True
            session.exec_stdin_identity = path
            continue
        streams = ((["stderr"] if r.fd == FD_STDERR else ["stdout"])
                   if r.fd != FD_BOTH else ["stdout", "stderr"])
        for stream in streams:
            setattr(session, f"exec_{stream}", path)
            setattr(session, f"exec_{stream}_append", r.append)
    return None


async def _roll_back(
    dispatch: DispatchFn,
    session: Session,
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
        session (Session): shell session state.
        saved (dict[str, str | bytes | bool | None]): the stream fields
            as they stood before the line.
        err (bytes): the diagnostic of the redirect that failed.
    """
    partial = session.exec_stderr
    for name, value in saved.items():
        setattr(session, name, value)
    out, err_bytes, _ = await _route(dispatch, session, partial, err,
                                     TO_STDERR)
    return _exec_failure(err_bytes, out)


async def _open_target(dispatch: DispatchFn, session: Session, scope: PathSpec,
                       append: bool) -> bool:
    """Open an `exec` redirect target, the way bash does at `exec` time.

    Truncating creates the file empty; appending creates it only when it
    is not already there, so an existing one keeps its bytes. Either way
    the file exists before the next statement runs, which is what makes
    `exec >> new; test -e new` succeed with nothing written. Returns
    whether it was written, which is what marks the target opened.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (Session): the session holding the umask.
        scope (PathSpec): the target.
        append (bool): whether the redirect is `>>`.
    """
    if append:
        try:
            await dispatch("stat", scope)
            return False
        except FS_ERRORS as exc:
            logger.debug("exec append target %s is new: %s", scope.raw_path,
                         exc)
    await create_file(dispatch, session, scope, b"")
    return True


def _error_line(label: str, exc: OSError) -> bytes:
    """bash's line for a redirect target it could not open.

    Args:
        label (str): the target as typed.
        exc (OSError): what the dispatcher raised.
    """
    strerror = fs_strerror(exc)
    return (f"{label}: {strerror}\n" if strerror else f"{label}\n").encode()


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
    return out, IOResult(exit_code=1,
                         stderr=err), ExecutionNode(command="exec",
                                                    exit_code=1,
                                                    stderr=err or b"")


async def read_open_source(dispatch: DispatchFn, identity: str) -> bytes:
    """The bytes a read through a read-open stream yields.

    The file an `OPEN_FOR_READING` identity names, from its start:
    mirage keeps no offset on a descriptor, where bash's second read
    through the same end would be at EOF. A file gone since `exec`
    opened it reads empty, where bash's still-open end would keep the
    old bytes.

    Args:
        dispatch (DispatchFn): op dispatcher.
        identity (str): the stream's binding, `<` then the path.
    """
    scope = _to_scope(identity[len(OPEN_FOR_READING):])
    try:
        data, _ = await dispatch("read", scope)
        return await materialize(data) or b""
    except FS_ERRORS as exc:
        logger.debug("exec read-open source gone for %s: %s", identity, exc)
        return b""


def _identity(session: Session, fd: int) -> tuple[str, bool]:
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
        session (Session): shell session state.
        fd (int): the descriptor being copied.
    """
    if fd == FD_STDIN:
        # fd 0 is its own read end unless an `exec` rebound it: closed,
        # or a writing stream's identity (`exec 0<&1`), which a later dup
        # from fd 0 copies as bash's does.
        identity = session.exec_stdin_identity
        return (TO_STDIN if identity is None else identity), False
    if fd == FD_STDERR:
        return (TO_STDERR if session.exec_stderr is None else
                session.exec_stderr, session.exec_stderr_append)
    return (TO_STDOUT if session.exec_stdout is None else session.exec_stdout,
            session.exec_stdout_append)


def _bind(session: Session, fd: int, identity: str, append: bool) -> None:
    """Point a writing stream at an identity.

    A stream on its own terminal end is stored as None, the undiverted
    state every reader of `exec_stdout`/`exec_stderr` already knows.

    Args:
        session (Session): shell session state.
        fd (int): the descriptor being bound, 1 or 2.
        identity (str): what `_identity` named, or `CLOSED`.
        append (bool): whether writes append, for a path.
    """
    if fd == FD_STDERR:
        session.exec_stderr = None if identity == TO_STDERR else identity
        session.exec_stderr_append = append
    else:
        session.exec_stdout = None if identity == TO_STDOUT else identity
        session.exec_stdout_append = append


async def _route(
    dispatch: DispatchFn,
    session: Session,
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
        session (Session): shell session state.
        binding (str | None): the stream's `exec` binding.
        data (bytes): what the statement wrote on it.
        own (str): the stream's own terminal end, used when undiverted.
    """
    target = own if binding is None else binding
    if target == TO_STDOUT:
        return data, None, False
    if target == TO_STDERR:
        return None, data, False
    if target == TO_STDIN or target.startswith(OPEN_FOR_READING):
        return None, None, True
    if target != CLOSED:
        await _append(dispatch, session, target, data)
    return None, None, False


def stdout_to_stderr(node: Any) -> bool:
    """Whether a statement sends its own stdout to stderr (``>&2``).

    What tells a writer's failed write from a lost diagnostic under an
    unwritable stderr: bash's ``echo hi >&2`` reports 1 when the write
    fails, while a program whose diagnostic could not be delivered keeps
    its own status.

    Args:
        node (Any): the statement's tree-sitter node.
    """
    if node.type != NT.REDIRECTED_STATEMENT:
        return False
    _, redirects = get_redirects(node)
    return any(
        isinstance(r.target, int) and r.target == FD_STDERR and r.fd in (
            FD_STDOUT, FD_BOTH) for r in redirects)


async def divert_statement(
    dispatch: DispatchFn,
    session: Session,
    stdout: bytes | None,
    io: IOResult,
    command: str,
    stdout_diverted: bool = False,
) -> bytes | None:
    """Send one statement's output where the shell's `exec` bindings point.

    Called after each top-level statement when an `exec` redirect is in
    force: a stream bound to a file is appended to it (the first write
    to each target having truncated it at `exec` time), one bound to
    the other terminal stream crosses over (`exec 2>&1` puts stderr on
    stdout), a closed one is dropped, and one bound to stdin fails with
    bash's `write error: Bad file descriptor`, which is reported on
    stderr through stderr's own binding and makes the statement's
    status 1. An unwritable stderr fails only a statement whose own
    output went there; a lost diagnostic leaves the status the command
    earned. Returns the stdout that should still bubble up, which is
    None once nothing is left for the terminal.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (Session): shell session state.
        stdout (bytes | None): the statement's materialized stdout.
        io (IOResult): the statement's result; its stderr and exit
            status are amended in place.
        command (str): the statement's recorded line; its first word
            names the writer in a write error.
        stdout_diverted (bool): the statement sent its own stdout to
            stderr (``>&2``), so an unwritable stderr is the writer's
            failure.
    """
    out_parts: list[bytes] = []
    err_parts: list[bytes] = []
    failed = False
    if stdout:
        out, err, failed = await _route(dispatch, session, session.exec_stdout,
                                        stdout, TO_STDOUT)
        out_parts.extend(x for x in (out, ) if x)
        err_parts.extend(x for x in (err, ) if x)
    stderr = (await materialize(io.stderr) or b"") if io.stderr else b""
    if failed:
        words = command.split()
        stderr += (f"{words[0] if words else 'bash'}: write error: "
                   "Bad file descriptor\n").encode()
        io.exit_code = 1
    if stderr:
        out, err, unwritable = await _route(dispatch, session,
                                            session.exec_stderr, stderr,
                                            TO_STDERR)
        out_parts.extend(x for x in (out, ) if x)
        err_parts.extend(x for x in (err, ) if x)
        if unwritable and stdout_diverted and io.exit_code == 0:
            # The statement's own output was what could not be written,
            # so the write error is its failure (bash's `echo hi >&2`
            # under `exec 2>&0` reports 1). A diagnostic that could not
            # be delivered leaves the status alone: GNU find still exits
            # 0 after `-exec nosuch`, ls keeps its 2 and cat its 1, since
            # the failed write is of a message, not of the work.
            io.exit_code = 1
    io.stderr = b"".join(err_parts) or None
    return b"".join(out_parts) or None


async def _append(dispatch: DispatchFn, session: Session, target: str,
                  data: bytes) -> None:
    """Append bytes to an `exec` target, or drop them if it is closed.

    Args:
        dispatch (DispatchFn): op dispatcher.
        session (Session): shell session state.
        target (str): the target path, or `""` for a closed stream.
        data (bytes): the bytes to write.
    """
    if target == CLOSED:
        return
    scope = _to_scope(target)
    # The target exists by now, since `exec` opened it: every write is
    # read-then-append. A file deleted since then reads empty rather
    # than failing, which is where the debug line below comes from.
    existing = b""
    try:
        prior, _ = await dispatch("read", scope)
        existing = await materialize(prior) or b""
    except FS_ERRORS as exc:
        logger.debug("exec append pre-read failed for %s: %s", target, exc)
    try:
        await dispatch("write", scope, data=existing + data)
        session._exec_opened.add(target)
    except FS_ERRORS as exc:
        logger.debug("exec write failed for %s: %s", target, exc)


async def exec_builtin(call: BuiltinCall) -> Result:
    """The ``exec`` arm.

    The redirect-only form is intercepted where redirects are applied;
    a bare ``exec`` reaching here has no redirects, and ``exec cmd`` is
    the process-replacement form this refuses.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_exec_command(list(call.argv.args), call.session)
