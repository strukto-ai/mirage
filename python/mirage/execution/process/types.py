from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from mirage.execution.process.constants import WORKSPACE_MACHINE
from mirage.execution.types import LineId, MachineName, MachinePid, ProcessId
from mirage.types import PathSpec


class ProcessState(str, Enum):
    RUNNING = "running"
    STOPPING = "stopping"
    EXITED = "exited"


@dataclass(frozen=True, slots=True)
class ProcessUsage:
    """What a scan read of a program's use of its machine: ``cpu_seconds``
    of CPU time so far, ``cpu_percent`` that time over the time it has
    run, ``memory_percent`` its resident memory over the machine's, and
    ``rss`` and ``vsz`` its resident and virtual size in KiB.
    """

    cpu_seconds: float
    cpu_percent: float
    memory_percent: float
    rss: int
    vsz: int


@dataclass(frozen=True, slots=True)
class Process:
    """One managed runner, as every instance on its store reads it: not
    an OS process or a shell job number. Its machine is where its
    program runs, ``machine_instance`` what its provider called it then,
    and its runtime what Mirage runs it with; a native program's own pid
    there is ``machine_pid``, and the letter ``ps``
    shows for what it is doing, when something knows, is ``shown_state``,
    and what the last scan read of its use of the machine ``usage``.

    ``ended_at`` is set exactly when ``state`` is final, with ``exit``
    the status, ``signal`` the signal that ended it, if one did, and
    ``error`` why its runner failed, if it did. ``ancestors`` are the
    pids above it, its parent last, so a process stays under an ancestor
    whose own record has gone. ``stages`` are the pids of the pipeline a
    background job runs; bash starts those from its shell, so the job's
    own process has no row in ``ps``.

    What it reads from other processes names their pids: ``stdin`` the
    one whose stdout is its stdin (the stage before it in a pipeline),
    ``fd`` the one writing each descriptor a ``<( )`` gave it, by number,
    and ``argv`` each whose output a ``$( )`` made its arguments of.
    """

    id: ProcessId
    session_id: str
    line: LineId | None
    parent: int | None
    group: int
    command: str
    cwd: PathSpec
    machine: MachineName
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
    usage: ProcessUsage | None = None
    machine_instance: str | None = None
    stdin: int | None = None
    fd: dict[int, int] = field(default_factory=dict)
    argv: tuple[int, ...] = ()

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
