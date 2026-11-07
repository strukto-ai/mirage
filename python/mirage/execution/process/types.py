from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from enum import Enum
from typing import Any

from mirage.execution.types import LineId, MachineId, MachinePid, ProcessId
from mirage.types import PathSpec


class ProcessState(str, Enum):
    RUNNING = "running"
    STOPPING = "stopping"
    EXITED = "exited"


@dataclass(frozen=True, slots=True)
class Process:
    """One managed runner, as every instance on its store reads it: not
    an OS process or a shell job number. Its machine is where its
    program runs and its runtime what Mirage runs it with; a native
    program's own pid there is ``machine_pid``.

    ``ended_at`` is set exactly when ``state`` is final, with ``exit``
    the status, ``signal`` the signal that ended it, if one did, and
    ``error`` why its runner failed, if it did. ``ancestors`` are the
    pids above it, its parent last, so a process stays under an ancestor
    whose own record has gone.
    """

    id: ProcessId
    session_id: str
    line: LineId | None
    parent: int | None
    group: int
    command: str
    cwd: PathSpec
    machine: MachineId
    started_at: float
    runtime: str | None = None
    machine_pid: MachinePid | None = None
    state: ProcessState = ProcessState.RUNNING
    ended_at: float | None = None
    exit: int | None = None
    signal: int | None = None
    error: str | None = None
    ancestors: tuple[int, ...] = ()

    @property
    def pid(self) -> int:
        """The pid the agent sees."""
        return self.id.pid


ProcessRunner = Callable[[], Coroutine[Any, Any, int]]


@dataclass(frozen=True, slots=True)
class SpawnRequest:
    argv: tuple[str, ...]
    cwd: PathSpec | None = None
    env: dict[str, str] | None = None
    replace_env: bool = False
    merge_stderr: bool = False
