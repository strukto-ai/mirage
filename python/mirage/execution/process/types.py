from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from enum import Enum
from typing import Any

from mirage.execution.process.constants import WORKSPACE_MACHINE
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
    program's own pid there is ``machine_pid``, and the letter ``ps``
    shows for what it is doing, when something knows, is ``shown_state``.

    ``ended_at`` is set exactly when ``state`` is final, with ``exit``
    the status, ``signal`` the signal that ended it, if one did, and
    ``error`` why its runner failed, if it did. ``ancestors`` are the
    pids above it, its parent last, so a process stays under an ancestor
    whose own record has gone. ``stages`` are the pids of the pipeline a
    background job runs; bash starts those from its shell, so the job's
    own process has no row in ``ps``.
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
    shown_state: str | None = None
    stages: tuple[int, ...] = ()

    @property
    def pid(self) -> int:
        """Mirage's own number for it, which its tag holds."""
        return self.id.pid

    @property
    def is_program(self) -> bool:
        """Whether it is a program on a machine, not Mirage's own."""
        return self.runtime is not None or self.machine_pid is not None

    @property
    def shown_pid(self) -> int:
        """The pid the agent sees: its program's on its machine, else
        Mirage's own."""
        return (
            self.machine_pid.pid if self.machine_pid is not None else self.pid
        )

    @property
    def shown_machine(self) -> str:
        """Where the agent sees it running."""
        return str(self.machine) if self.is_program else WORKSPACE_MACHINE


ProcessRunner = Callable[[], Coroutine[Any, Any, int]]


@dataclass(frozen=True, slots=True)
class SpawnRequest:
    argv: tuple[str, ...]
    cwd: PathSpec | None = None
    env: dict[str, str] | None = None
    replace_env: bool = False
    merge_stderr: bool = False
