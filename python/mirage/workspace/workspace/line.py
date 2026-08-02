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

from mirage.commands.builtin.utils.safeguard import (guard_output,
                                                     run_with_timeout)
from mirage.io import IOResult
from mirage.io.types import ByteSource, materialize
from mirage.runtime.base import Runtime
from mirage.runtime.policy.safeguard import resolve_safeguard
from mirage.workspace.mount import MountEntry
from mirage.workspace.session import Session
from mirage.workspace.workspace.utils import command_name


async def run_whole_line(
        runtime: Runtime, command: str, stdin: ByteSource | None,
        session: Session, mounts: list[MountEntry],
        invalidate: Callable[[], Awaitable[None]]) -> IOResult:
    """Hand the raw line to one runtime instead of walking its tree.

    A whole line is a command like any other: the same safeguard
    resolution and boundary rule as the tree, so ``timeout_seconds``
    answers 124 and ``max_bytes``/``max_lines`` cap the output.

    Args:
        runtime (Runtime): the runtime that captured the whole line.
        command (str): the raw command line.
        stdin (ByteSource | None): bytes piped into the line.
        session (Session): session supplying cwd and env.
        mounts (list[MountEntry]): mounts whose per-command safeguards
            apply.
        invalidate (Callable[[], Awaitable[None]]): drops local read
            caches once the line has run.
    """
    data = await materialize(stdin) if stdin is not None else None
    name = command_name(command)
    guard = resolve_safeguard(name, mounts)
    timeout = guard.timeout_seconds if guard is not None else None
    try:
        result = await run_with_timeout(
            runtime.run_line(command, data, dict(session.env), session.cwd),
            timeout, name)
    finally:
        # The line may have written anywhere in the runtime's view of
        # the workspace; local read caches are stale.
        await invalidate()
    stdout, stderr, exit_code = await guard_output(result.stdout or b"",
                                                   result.stderr,
                                                   result.exit_code, guard)
    return IOResult(exit_code=exit_code, stdout=stdout, stderr=stderr)
