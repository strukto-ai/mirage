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

import tree_sitter

from mirage.commands.spec.usage import read_fail_exit
from mirage.io import IOResult
from mirage.io.types import ByteSource, materialize
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.node_kind import pipeline_transparent
from mirage.utils.errors import format_fs_error
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


def record_status(session: Session,
                  code: int,
                  *,
                  transparent: bool = False) -> None:
    """Record a finished statement's exit status: ``$?`` and
    ``${PIPESTATUS[@]}`` together.

    The one door every status write goes through, so the two can never
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
        session (Session): shell session receiving the status.
        code (int): the statement's exit status.
        transparent (bool): whether the statement is not a pipeline of
            its own.
    """
    session.last_exit_code = code
    pending = session._pipe_status_pending
    session._pipe_status_pending = None
    if pending is not None:
        session.pipe_status = pending
    elif not transparent:
        session.pipe_status = (code, )


def carry_status(session: Session) -> None:
    """Park the status just recorded again, for the boundary that closes
    the enclosing statement to claim rather than stamp over.

    A conditional list that short-circuits has closed its left pipeline
    and runs nothing else, and bash reports the list as that pipeline:
    ``true | false && true`` keeps ``0 1``. The list is not a pipeline
    of its own, so without this its boundary would stamp the aggregate
    ``1``.

    Args:
        session (Session): shell session carrying the status.
    """
    session._pipe_status_pending = session.pipe_status


async def finish_statement(
    stdout: ByteSource | None,
    io: IOResult,
    session: Session,
    node: tree_sitter.Node | None = None,
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
        session (Session): shell session receiving the status.
        node (tree_sitter.Node | None): the statement that finished,
            which decides whether it stamps ``PIPESTATUS`` itself; None
            (a caller without the node) stamps.
        exec_node (ExecutionNode | None): the statement's record, whose
            command names a failed read and whose operands respell its
            path as typed.
    """
    try:
        result = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
    except OSError as exc:
        command = exec_node.command if exec_node is not None else ""
        cmd_name = command.split()[0] if command else ""
        paths = exec_node.paths if exec_node is not None else []
        existing = await materialize(io.stderr) or b""
        io.stderr = existing + format_fs_error(cmd_name, exc, paths)
        io.exit_code = read_fail_exit(cmd_name, exc)
        result = None
    record_status(session,
                  io.exit_code,
                  transparent=node is not None and pipeline_transparent(node))
    return result


def assignment_status(session: Session, seq_before: int) -> int:
    """Exit status of an assignment-only statement.

    Bash: an assignment statement exits 0 unless expanding it ran
    command substitutions, in which case the status of the last
    substitution performed becomes the statement's own.

    Args:
        session (Session): shell session carrying substitution counters.
        seq_before (int): session._cmdsub_seq snapshot taken before the
            assignment expanded its value.
    """
    if session._cmdsub_seq != seq_before:
        return session._cmdsub_status
    return 0
