from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mirage.workspace.session.session import SessionState


@dataclass
class ExecutionFrame:
    """Temporary state of one evaluation; never part of a session record."""

    parent: "SessionState | None" = None
    diagnostics: list[str | bytes] = field(default_factory=list)
    # Assignment status follows the last substitution in this evaluation.
    cmdsub_seq: int = 0
    cmdsub_status: int = 0

    def fork(self) -> "ExecutionFrame":
        return ExecutionFrame()


def persistent_session(session: "SessionState") -> "SessionState":
    return getattr(session, "_state", session)


def parent_session(session: "SessionState") -> "SessionState | None":
    frame: ExecutionFrame | None = getattr(session, "_frame", None)
    return frame.parent if frame is not None else None
