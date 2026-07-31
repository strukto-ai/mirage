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

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.workspace.session import Session


async def finish_statement(
    stdout: ByteSource | None,
    io: IOResult,
    session: Session,
) -> ByteSource | None:
    """Finalize a completed statement and seed $? for the next one.

    Every statement boundary must do the same dance: apply a VALUE
    barrier so lazily finalized exit codes (grep's exit_on_empty) are
    concrete, then record the status the next statement's $? expands
    to. Statement-list loops (program, subshell, brace group, if/loop/
    case bodies, function bodies, && / || / ; lists) call this instead
    of hand-rolling the triple, so a new construct cannot forget it.

    Args:
        stdout (ByteSource | None): the statement's possibly-lazy stdout.
        io (IOResult): the statement's result; exit_code may still be
            provisional until the barrier runs.
        session (Session): shell session receiving last_exit_code.
    """
    result = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
    session.last_exit_code = io.exit_code
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
