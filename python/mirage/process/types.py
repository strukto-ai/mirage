from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mirage.process.child import ChildProcess

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
    command: str | None
    cwd: PathSpec | None
    started_at: float
    state: ProcessState = ProcessState.RUNNING
    cancellation_requested: bool = False
    exit_code: int | None = None
    failure: str | None = None
    parent_pid: int | None = None
    group_id: int = 0


@dataclass(frozen=True, slots=True)
class ProcessView:
    """Process operations scoped to one session incarnation and its profile.

    An absent or invisible PID returns None. Metadata grants no output
    access; control and spawn are checked separately. The view carries no
    reference to mutable tasks.
    """

    list: Callable[[], tuple[ProcessInfo, ...]]
    get: Callable[[int], ProcessInfo | None]
    check_spawn: Callable[[], None]
    terminate: Callable[[int], bool]
    wait: Callable[[int], Awaitable[ProcessInfo | None]]
    depth: int = 0
    spawn: Callable[["SpawnRequest"], "ChildProcess"] | None = None


ProcessRunner = Callable[[], Coroutine[Any, Any, int]]


@dataclass(frozen=True, slots=True)
class SpawnRequest:
    argv: tuple[str, ...]
    cwd: PathSpec | None = None
    env: dict[str, str] | None = None
    replace_env: bool = False
    merge_stderr: bool = False
