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

from __future__ import annotations

from asyncio import Event
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from mirage.execution.job import JobTable
    from mirage.execution.line.handle import LineHandle
    from mirage.io.types import ByteSource, IOResult
    from mirage.policy.types import HandOff
    from mirage.rs.session import ShellVars
    from mirage.shell.call_stack import CallStack
    from mirage.shell.console import JobConsole
    from mirage.shell.types import TSNodeLike
    from mirage.workspace.evaluation import EvaluationContext
    from mirage.workspace.session.session import SessionState


class ExecuteFn(Protocol):
    """The executor's typed entry point for a nested line."""

    async def __call__(
        self,
        command: str,
        *,
        session_id: str,
        session: SessionState | None = None,
        context: EvaluationContext | None = None,
        line_handle: LineHandle | None = None,
        stdin: ByteSource | None = None,
        cancel: Event | None = None,
        node: TSNodeLike | None = None,
        span: tuple[int, int] | None = None,
        handed: HandOff | None = None,
        substitution: bool = False,
        records: ShellVars | None = None,
        read: list[str] | None = None,
        sink: JobConsole | None = None,
        call_stack: CallStack | None = None,
        job_table: JobTable | None = None,
    ) -> IOResult: ...
