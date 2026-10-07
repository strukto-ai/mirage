from dataclasses import dataclass, field

from mirage.observe.context import Recorder


@dataclass
class ExecutionFrame:
    """Temporary state of one evaluation; never part of a session record."""

    recorder: Recorder | None = None
    diagnostics: list[str | bytes] = field(default_factory=list)
    cmdsub_seq: int = 0
    cmdsub_status: int = 0

    def fork(self) -> "ExecutionFrame":
        """A child evaluation's frame, which starts empty.

        TypeScript's also carries the abort signal; here cancellation is
        the asyncio task's and is ambient.

        Args:
            None
        """
        return ExecutionFrame(recorder=self.recorder)
