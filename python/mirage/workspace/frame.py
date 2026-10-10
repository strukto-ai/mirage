from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from mirage.io.types import IOResult
from mirage.shell.types import TSNodeLike


@dataclass
class ExecutionFrame:
    """Temporary state of one evaluation; never part of a session record."""

    diagnostics: list[str | bytes] = field(default_factory=list)
    cmdsub_seq: int = 0
    cmdsub_status: int = 0
    process_sub: (
        Callable[
            [TSNodeLike, Callable[[str], Awaitable[IOResult]]], Awaitable[str]
        ]
        | None
    ) = None

    def fork(self) -> "ExecutionFrame":
        """A child evaluation's frame, which starts empty.

        TypeScript's also carries the abort signal; here cancellation is
        the asyncio task's and is ambient.

        Args:
            None
        """
        return ExecutionFrame()
