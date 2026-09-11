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

from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.limit import guard_output, run_with_timeout
from mirage.io import IOResult
from mirage.io.types import ByteSource, materialize
from mirage.policy import (ExecuteResultContext, Policies, post_execute_gate,
                           refusal_of, render_deny, resolve_limit)
from mirage.runtime.mixin import LineExecutorMixin
from mirage.types import Producer
from mirage.workspace.mount import MountEntry
from mirage.workspace.session import Session, env_snapshot
from mirage.workspace.workspace.utils import command_name


async def run_whole_line(
        runtime: LineExecutorMixin, command: str, stdin: ByteSource | None,
        session: Session, mounts: list[MountEntry], policies: Policies,
        invalidate: Callable[[], Awaitable[None]]) -> IOResult:
    """Hand the raw line to one runtime instead of walking its tree.

    A whole line is a command like any other: the same boundary
    consultation as the tree, so ``timeout_seconds`` answers 124 and
    the policies' merged Limit caps the output.

    Args:
        runtime (LineExecutorMixin): the runtime that captured the
            whole line.
        command (str): the raw command line.
        stdin (ByteSource | None): bytes piped into the line.
        session (Session): session supplying cwd and env.
        mounts (list[MountEntry]): mounts the line may span (every
            mount: a whole-line runtime sees the full workspace).
        policies (Policies): the workspace's policies.
        invalidate (Callable[[], Awaitable[None]]): drops local read
            caches once the line has run.
    """
    data = await materialize(stdin) if stdin is not None else None
    name = command_name(command)
    guard = resolve_limit(name, mounts)
    timeout = guard.timeout_seconds if guard is not None else None
    try:
        result = await run_with_timeout(
            runtime.run_line(command, data, env_snapshot(session),
                             session.cwd), timeout, name)
    finally:
        # The line may have written anywhere in the runtime's view of
        # the workspace; local read caches are stale.
        await invalidate()
    producer = Producer(command=name, prefixes=tuple(m.prefix for m in mounts))
    deny, bound = await post_execute_gate(
        policies,
        ExecuteResultContext(producer=producer, exit_code=result.exit_code))
    if deny is not None:
        existing = result.stderr or b""
        err, code = render_deny(name, deny)
        return IOResult(exit_code=code,
                        stdout=None,
                        stderr=existing + err,
                        refusal=refusal_of(deny))
    stdout, stderr, exit_code = await guard_output(result.stdout or b"",
                                                   result.stderr,
                                                   result.exit_code, bound)
    return IOResult(exit_code=exit_code, stdout=stdout, stderr=stderr)
