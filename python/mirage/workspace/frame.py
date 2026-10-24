from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from mirage.shell.types import TSNodeLike

if TYPE_CHECKING:
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
    """Temporary state of one evaluation; never part of a session record."""

    diagnostics: list[str | bytes] = field(default_factory=list)
    cmdsub_seq: int = 0
    cmdsub_status: int = 0
    process_sub: (
        Callable[[TSNodeLike, ProcessSubLine], Awaitable[str]] | None
    ) = None
    routing: RouteDecision[RuntimeIdentity] | None = None

    def fork(self) -> ExecutionFrame:
        """A child evaluation's frame, which starts empty but for the
        line's routing decision: nested lines never re-route.

        TypeScript's also carries the abort signal; here cancellation is
        the asyncio task's and is ambient.

        Args:
            None
        """
        return ExecutionFrame(routing=self.routing)
