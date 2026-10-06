from dataclasses import dataclass, field


@dataclass
class ExecutionFrame:
    """Temporary state of one evaluation; never part of a session record."""

    diagnostics: list[str | bytes] = field(default_factory=list)
    cmdsub_seq: int = 0
    cmdsub_status: int = 0

    def fork(self) -> "ExecutionFrame":
        return ExecutionFrame()
