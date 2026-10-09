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

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from mirage.commands.spec.usage import read_fail_exit_code
from mirage.errors.render import format_fs_error
from mirage.io import IOResult
from mirage.io.async_line_iterator import SharedInput
from mirage.io.types import ByteSource, materialize
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.console import Channel, JobConsole
from mirage.shell.constants import ERREXIT_EXEMPT_TYPES
from mirage.shell.descriptors import (
    ENCLOSING,
    Inherited,
    Recorder,
    StreamOwner,
    deliver,
    unreadable_stdin,
)
from mirage.shell.node_kind import pipeline_transparent
from mirage.shell.types import TSNodeLike
from mirage.workspace.abort import StatusWriter, line_status_writer
from mirage.workspace.frame import ExecutionFrame
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def record_status(
    session: SessionState, code: int, *, transparent: bool = False
) -> None:
    """Record a finished statement's exit status: ``$?`` and
    ``${PIPESTATUS[@]}`` together.

    The one function every status write goes through, so the two can never
    disagree. ``handle_pipe`` parks its per-segment statuses on the
    session, and the boundary that closes the pipeline claims them here;
    a boundary with nothing parked stamps its own one-element status,
    which is what a simple command, a function call or a subshell
    leaves in bash. A *transparent* statement (a group, a list, a loop,
    a negation, a redirected pipeline: see ``pipeline_transparent``)
    claims what was parked but never overwrites, because bash reports
    the last pipeline that ran *inside* it (``{ false | true; }`` keeps
    ``1 0``).

    Args:
        session (SessionState): shell session receiving the status.
        code (int): the statement's exit status.
        transparent (bool): whether the statement is not a pipeline of
            its own.
    """
    # Whose status this is, so a cancelled line puts back only what it
    # overwrote and never a concurrent line's finished result.
    session.status_writer = line_status_writer()
    session.last_exit_code = code
    pending = session._pipe_status_pending
    session._pipe_status_pending = None
    if pending is not None:
        session.pipe_status = pending
    elif not transparent:
        session.pipe_status = (code,)


@dataclass(frozen=True, slots=True)
class StatusSnapshot:
    """The status a line found, taken before its first statement runs
    and put back if the caller cancels the line.

    A cancelled invocation is the caller's outcome, not the shell's, so
    it must leave ``$?`` where it was. But the cancellation lands on one
    await inside the line, and every statement before that await has
    already stamped through ``record_status``; only a copy taken before
    the line can undo them.

    The three fields travel together because they are one shell fact:
    ``$?``, ``${PIPESTATUS[@]}``, and the per-segment statuses a
    pipeline parked for its boundary to claim. Restoring one without
    the others would leave a state no bash line produces.

    Attributes:
        last_exit_code (int): ``$?``.
        pipe_status (tuple[int, ...]): ``${PIPESTATUS[@]}``.
        pipe_status_pending (tuple[int, ...] | None): statuses a
            pipeline parked for the enclosing boundary.
    """

    last_exit_code: int
    pipe_status: tuple[int, ...]
    pipe_status_pending: tuple[int, ...] | None


def snapshot_status(session: SessionState) -> StatusSnapshot:
    """Capture ``$?`` and ``${PIPESTATUS[@]}`` before a line runs.

    Args:
        session (SessionState): shell session whose status is captured.
    """
    return StatusSnapshot(
        session.last_exit_code,
        session.pipe_status,
        session._pipe_status_pending,
    )


def restore_status(
    session: SessionState,
    snapshot: StatusSnapshot,
    writer: StatusWriter | None,
) -> None:
    """Put back the status a line found, for a line the caller aborted.

    Statements inside the line may already have stamped their own
    status before the abort landed, and an aborted invocation is the
    caller's outcome, not the shell's.

    Only what this line overwrote, though. Two ``execute()`` calls can
    share a session, and a snapshot taken before a concurrent line
    finished is older than that line's result: putting it back would
    resurrect a value the shell had already moved past. So the restore
    happens only while the last stamp is still this line's. When nobody
    has stamped since the snapshot the status already equals it and
    declining is the same thing; when someone else did, declining is
    the point.

    Args:
        session (SessionState): shell session receiving the status.
        snapshot (StatusSnapshot): what ``snapshot_status`` captured.
        writer (StatusWriter | None): the restoring line's identity.
    """
    if session.status_writer is not writer:
        return
    session.last_exit_code = snapshot.last_exit_code
    session.pipe_status = snapshot.pipe_status
    session._pipe_status_pending = snapshot.pipe_status_pending


def carry_status(session: SessionState) -> None:
    """Park the status just recorded again, for the boundary that closes
    the enclosing statement to claim rather than stamp over.

    A conditional list that short-circuits has closed its left pipeline
    and runs nothing else, and bash reports the list as that pipeline:
    ``true | false && true`` keeps ``0 1``. The list is not a pipeline
    of its own, so without this its boundary would stamp the aggregate
    ``1``.

    Args:
        session (SessionState): shell session carrying the status.
    """
    session._pipe_status_pending = session.pipe_status


@contextmanager
def ignoring_errexit(session: SessionState) -> Iterator[None]:
    """Run a test, the left of ``&&``/``||`` or a negated command where
    bash ignores ``set -e``: nothing it runs exits for a failure, a
    function body or a subshell included.

    Args:
        session (SessionState): the shell running it.
    """
    saved = session.errexit_ignored
    session.errexit_ignored = True
    try:
        yield
    finally:
        session.errexit_ignored = saved


def errexit_acts(node: TSNodeLike, status: int, session: SessionState) -> bool:
    """Whether ``set -e`` ends the shell after this statement, marking
    the shell as ending when it does.

    Args:
        node (TSNodeLike): the statement that finished.
        status (int): its status.
        session (SessionState): the shell it ran in.
    """
    acts = (
        status != 0
        and bool(session.shell_options.get("errexit"))
        and node.type not in ERREXIT_EXEMPT_TYPES
        and not session.errexit_immune
        and not session.errexit_ignored
    )
    if acts:
        session.errexit_exiting = True
    return acts


async def finish_statement(
    stdout: ByteSource | None,
    io: IOResult,
    session: SessionState,
    node: TSNodeLike | None = None,
    exec_node: ExecutionNode | None = None,
) -> ByteSource | None:
    """Finalize a completed statement and seed $? for the next one.

    Every statement boundary must do the same dance: apply a VALUE
    barrier so lazily finalized exit codes (grep's exit_on_empty) are
    concrete, then record the status the next statement's $? expands
    to. Statement-list loops (program, subshell, brace group, if/loop/
    case bodies, function bodies, && / || / ; lists) call this instead
    of hand-rolling the triple, so a new construct cannot forget it.

    The barrier is the first pull of a lazy stream, so a read that
    fails there (``cat`` on a closed stdin, a size guard) is the
    statement's failure, in the command's own words, rather than an
    exception that escapes the body and kills the line; the program
    loop drains the same way.

    Args:
        stdout (ByteSource | None): the statement's possibly-lazy stdout.
        io (IOResult): the statement's result; exit_code may still be
            provisional until the barrier runs.
        session (SessionState): shell session receiving the status.
        node (TSNodeLike | None): the statement that finished,
            which decides whether it stamps ``PIPESTATUS`` itself; None
            (a caller without the node) stamps.
        exec_node (ExecutionNode | None): the statement's record, whose
            command names a failed read and whose operands respell its
            path as typed.
    """
    try:
        result = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
    except OSError as exc:
        await failed_read(io, exc, exec_node)
        result = None
    record_status(
        session,
        io.exit_code,
        transparent=node is not None and pipeline_transparent(node),
    )
    return result


async def failed_read(
    io: IOResult, exc: OSError, exec_node: ExecutionNode | None
) -> None:
    """A read the statement's output stream failed, as its own failure:
    ``cat: -: Bad file descriptor`` on its stderr and status.

    Args:
        io (IOResult): the statement's result, amended in place.
        exc (OSError): what the read raised.
        exec_node (ExecutionNode | None): the statement's record, whose
            command names the failure and whose operands respell its
            path as typed.
    """
    command = exec_node.command if exec_node is not None else ""
    cmd_name = command.split()[0] if command else ""
    paths = exec_node.paths if exec_node is not None else []
    existing = await materialize(io.stderr) or b""
    io.stderr = existing + format_fs_error(cmd_name, exc, paths)
    io.exit_code = read_fail_exit_code(cmd_name, exc)


def fd0_binding(session: SessionState) -> tuple[SharedInput | None, bool]:
    """What the shell's fd 0 is bound to: the descriptor ``exec <``
    opened, and whether an ``exec`` left it unreadable (``exec <&-``).

    A construct takes this as it starts, so ``statement_stdin`` can tell
    an ``exec`` made inside it from one made before it.

    Args:
        session (SessionState): shell session.
    """
    return session.exec_stdin, session.exec_stdin_unreadable


def statement_stdin(
    session: SessionState,
    stdin: ByteSource | None,
    bound: tuple[SharedInput | None, bool],
) -> ByteSource | None:
    """The stdin one statement of a construct reads.

    bash's fd 0 is one descriptor, so an ``exec <`` replaces whatever a
    construct was handed: ``printf z | { exec < f; read a; }`` reads
    ``f``. Every statement-list loop asks this before each statement.
    The construct's own stdin stands while fd 0 is still what it was
    when the construct started; a construct handed none reads fd 0,
    the descriptor ``exec <`` opened or EBADF after ``exec <&-``.

    Args:
        session (SessionState): shell session.
        stdin (ByteSource | None): the construct's stdin.
        bound (tuple[SharedInput | None, bool]): ``fd0_binding`` as the
            construct started.
    """
    if stdin is not None and fd0_binding(session) == bound:
        return stdin
    if session.exec_stdin_unreadable:
        return unreadable_stdin()
    if session.exec_stdin is not None:
        return session.exec_stdin
    return stdin


def assignment_status(frame: ExecutionFrame, seq_before: int) -> int:
    """Exit status of an assignment-only statement.

    Bash: an assignment statement exits 0 unless expanding it ran
    command substitutions, in which case the status of the last
    substitution performed becomes the statement's own.

    Args:
        frame (ExecutionFrame): counters owned by this evaluation.
        seq_before (int): frame.cmdsub_seq snapshot taken before the
            assignment expanded its value.
    """
    if frame.cmdsub_seq != seq_before:
        return frame.cmdsub_status
    return 0


# One piece of what a statement wrote, in order: its channel, its
# bytes, and whether it went to the terminal through a copy, which an
# `exec` diversion of the shell's own output leaves where it is.
Written = tuple[Channel, bytes, bool]


def as_written(stdout: bytes | None, stderr: bytes | None) -> list[Written]:
    """Output written as it is, stdout then stderr, none of it through a
    copy of the terminal.

    Args:
        stdout (bytes | None): what went to standard output.
        stderr (bytes | None): what went to standard error.
    """
    return [
        (channel, data, False)
        for channel, data in (
            (Channel.STDOUT, stdout),
            (Channel.STDERR, stderr),
        )
        if data
    ]


@contextmanager
def recording(session: SessionState, recorder: Recorder) -> Iterator[None]:
    """Run a statement into ``recorder``: what it writes to an enclosing
    level's stream, and what a job this shell started writes while it
    runs, land among what it writes.

    Args:
        session (SessionState): the shell running it.
        recorder (Recorder): where it writes.
    """
    enclosing = ENCLOSING.set(recorder)
    jobs = session.job_output or session.tty.jobs
    held, jobs.recorder = jobs.recorder, recorder
    try:
        yield
    finally:
        jobs.recorder = held
        ENCLOSING.reset(enclosing)


async def statement_output(
    recorder: Recorder,
    stdout: ByteSource | None,
    io: IOResult,
    own: StreamOwner | None,
    sink: JobConsole | None,
) -> list[Written]:
    """What a statement wrote that stays with the shell running it,
    taken off ``recorder``.

    Bytes written to the shell's terminal through a copy (``exec 3>&1``,
    whose owner is ``own``) stay, flagged; bytes written to an enclosing
    level's stream go on there. What the statement returned rather than
    wrote comes last, its stderr taken off ``io``.

    Args:
        recorder (Recorder): what the statement wrote.
        stdout (ByteSource | None): what it returned.
        io (IOResult): its result.
        own (StreamOwner | None): the terminal of the shell this loop
            runs, None for a nested program of the same shell.
        sink (JobConsole | None): where the loop writes, if anywhere.
    """
    written: list[Written] = []
    chunks, recorder.chunks = recorder.chunks, []
    for key, data in chunks:
        if not isinstance(key, Inherited):
            written.append((key, data, False))
        elif key.owner is own or not await deliver(sink, key, data):
            written.append((key.channel, data, True))
    out = await materialize(stdout)
    if out:
        written.append((Channel.STDOUT, out, False))
    err = await materialize(io.stderr)
    io.stderr = None
    if err:
        written.append((Channel.STDERR, err, False))
    return written


async def land(
    written: list[Written],
    sink: JobConsole | None,
    all_stdout: list[ByteSource | None],
    merged_io: IOResult,
) -> IOResult:
    """Put a statement's output where its shell's goes: the sink, in
    order, or the stdout and stderr the shell returns. The result keeps
    its status.

    Args:
        written (list[Written]): the statement's output in order.
        sink (JobConsole | None): the shell's sink, if it has one.
        all_stdout (list[ByteSource | None]): stdout so far, extended.
        merged_io (IOResult): the result so far.
    """
    if sink is not None:
        for channel, data, _ in written:
            await sink.emit(channel, data)
        return merged_io
    stdout = b"".join(d for c, d, _ in written if c == Channel.STDOUT)
    if stdout:
        all_stdout.append(stdout)
    stderr = b"".join(d for c, d, _ in written if c == Channel.STDERR)
    if not stderr:
        return merged_io
    return await merged_io.merge(
        IOResult(stderr=stderr, exit_code=merged_io.exit_code)
    )
