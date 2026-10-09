from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from enum import Enum
from typing import Any

from mirage.types import PathSpec


class ProcessState(str, Enum):
    RUNNING = "running"
    STOPPING = "stopping"
    EXITED = "exited"


@dataclass(frozen=True, slots=True)
class ProcessInfo:
    """A managed runner, not an OS process or a shell job number."""

    pid: int
    session_id: str
    command: str
    cwd: PathSpec
    started_at: float
    execution_id: str
    parent_execution_id: str | None
    root_execution_id: str
    state: ProcessState = ProcessState.RUNNING
    cancellation_requested: bool = False
    exit_code: int | None = None
    failure: str | None = None
    parent_pid: int | None = None
    group_id: int = 0


ProcessRunner = Callable[[], Coroutine[Any, Any, int]]


@dataclass(frozen=True, slots=True)
class SpawnRequest:
    argv: tuple[str, ...]
    cwd: PathSpec | None = None
    env: dict[str, str] | None = None
    replace_env: bool = False
    merge_stderr: bool = False
