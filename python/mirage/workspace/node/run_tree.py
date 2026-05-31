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
from typing import Any, Callable

from mirage.commands.builtin.utils.safeguard import apply_safeguard
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.shell.barrier import BarrierPolicy, apply_barrier
from mirage.shell.job_table import JobTable
from mirage.workspace.mount import MountRegistry
from mirage.workspace.node.execute_node import execute_node
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def run_command_tree(
    dispatch: Callable,
    registry: MountRegistry,
    job_table: JobTable,
    execute_fn: Callable,
    agent_id: str,
    ast: Any,
    session: Session,
    stdin: Any,
    history: object,
    cancel: asyncio.Event | None,
) -> tuple[IOResult, ExecutionNode]:
    """Run a parsed command tree and finalize its output stream.

    Executes the AST root, then applies the value barrier and the
    command safeguard, folding the safeguard's stderr and exit code
    into the result. This is the seam between the Workspace shell
    (sessions, drift, history, recording, native dispatch) and the
    command executor: a caller hands in a parsed tree plus its
    dependencies and gets back the resolved result. Byte recording is
    the caller's responsibility, so the active recorder spans the
    stream consumption that happens inside the barrier here.

    Args:
        dispatch (Callable): VFS op dispatcher (op, path, **kw).
        registry (MountRegistry): mount registry for path resolution.
        job_table (JobTable): background job management.
        execute_fn (Callable): recursive execute (for source/eval).
        agent_id (str): current agent ID for jobs.
        ast (Any): parsed tree-sitter root node.
        session (Session): shell session state.
        stdin (Any): input stream.
        history (object): execution history sink.
        cancel (asyncio.Event | None): event used to abort mid-flight.

    Returns:
        tuple[IOResult, ExecutionNode]: the finalized result (with
        ``io.stdout`` set to the barrier-resolved value) and the
        execution node.
    """
    stdout, io, exec_node = await execute_node(
        dispatch,
        registry,
        job_table,
        execute_fn,
        agent_id,
        ast,
        session,
        stdin,
        history=history,
        cancel=cancel,
    )
    stdout = await apply_barrier(stdout, io, BarrierPolicy.VALUE)
    if io.safeguard is not None:
        stdout, sg_io = await apply_safeguard(stdout, io.safeguard)
        if sg_io.stderr is not None:
            existing = await materialize(io.stderr)
            io.stderr = existing + await materialize(sg_io.stderr)
        if sg_io.exit_code != 0:
            io.exit_code = sg_io.exit_code
    io.stdout = stdout
    return io, exec_node
