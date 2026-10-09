from dataclasses import dataclass
from enum import Enum

from mirage.types import JsonValue


@dataclass(frozen=True, slots=True)
class ExecutionIdentity:
    id: str
    parent_id: str | None
    root_id: str


class ExecutionStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    STOPPING = "stopping"
    DONE = "done"
    FAILED = "failed"
    CANCELED = "canceled"


@dataclass(frozen=True, slots=True)
class ExecutionRecord:
    id: str
    workspace_id: str
    session_id: str
    command: str
    submitted_at: float
    status: ExecutionStatus = ExecutionStatus.PENDING
    revision: int = 0
    cancel_requested: bool = False
    started_at: float | None = None
    finished_at: float | None = None
    result: JsonValue = None
    error: str | None = None
