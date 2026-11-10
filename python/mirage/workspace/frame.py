from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from mirage.shell.types import TSNodeLike

if TYPE_CHECKING:
    from mirage.execution.process.handle import ProcessHandle
    from mirage.io.types import ByteSource, IOResult
    from mirage.runtime.types import RouteDecision, RuntimeIdentity
    from mirage.shell.console import JobConsole


class ProcessSubLine(Protocol):
    async def __call__(
        self,
        text: str,
        *,
        stdin: ByteSource | None = None,
        sink: JobConsole | None = None,
    ) -> IOResult: ...


@dataclass
class ExecutionFrame:
    """Temporary state of one evaluation; never part of a session record.

    ``shell`` is the process whose shell the evaluation runs in (a line,
    a subshell, a pipeline stage, a nested shell, a job that runs
    commands of its own), each program of which a signal the shell
    ignores still reaches; None where the evaluation is one program run
    in place (``sleep 3 &``). ``reports`` are the report lines of the
    jobs a signal ended that the running command reaped, which go out
    after its stderr, around a redirect of its own; a command
    substitution's shell, and the shells it forks, make none
    (``substitution``).
    """

    diagnostics: list[str | bytes] = field(default_factory=list)
    reports: list[bytes] = field(default_factory=list)
    cmdsub_seq: int = 0
    cmdsub_status: int = 0
    process_sub: (
        Callable[[TSNodeLike, ProcessSubLine], Awaitable[str]] | None
    ) = None
    routing: RouteDecision[RuntimeIdentity] | None = None
    runs_on_machine: Callable[..., bool] | None = None
    line_timeout: float | None = None
    shell: ProcessHandle | None = None
    substitution: bool = False

    def fork(self) -> ExecutionFrame:
        """A child evaluation's frame, which starts empty but for the
        line's routing decision, since nested lines never re-route, its
        time limit, which a job it starts runs under from its own start,
        the process whose shell it is part of, and whether that shell is
        a substitution's.

        TypeScript's also carries the abort signal; here cancellation is
        the asyncio task's and is ambient.

        Args:
            None
        """
        return ExecutionFrame(
            routing=self.routing,
            runs_on_machine=self.runs_on_machine,
            line_timeout=self.line_timeout,
            shell=self.shell,
            substitution=self.substitution,
        )
