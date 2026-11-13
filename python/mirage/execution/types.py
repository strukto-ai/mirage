from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class LineId:
    """One line a shell read, as every record of it names it."""

    value: str

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True, slots=True)
class ProcessId:
    """One process of a workspace: its pid never repeats there, so the
    pair names it wherever workspaces meet, written ``w1:9``."""

    workspace_id: str
    pid: int

    def __str__(self) -> str:
        return f"{self.workspace_id}:{self.pid}"

    @classmethod
    def parse(cls, text: str) -> "ProcessId":
        """The id ``str`` wrote.

        Args:
            text (str): ``<workspace id>:<pid>``.

        Raises:
            ValueError: the text names no process.
        """
        workspace_id, sep, pid = text.rpartition(":")
        if not sep or not pid.isdigit():
            raise ValueError(f"not a process id: {text!r}")
        return cls(workspace_id, int(pid))


@dataclass(frozen=True, slots=True)
class JobId:
    """One job of a workspace, named by its console, which no other job
    shares even when it takes a number a reaped one had, written
    ``job_`` and 32 hex digits."""

    workspace_id: str
    console: str


@dataclass(frozen=True, slots=True)
class MachineName:
    """Where a process runs: the provider that reaches the machine and
    the name the workspace gave it, written ``docker:tools``. What the
    provider calls the machine is its handle's ``instance``."""

    provider: str
    name: str

    def __str__(self) -> str:
        return f"{self.provider}:{self.name}"

    @classmethod
    def parse(cls, text: str) -> "MachineName":
        """The name ``str`` wrote.

        Args:
            text (str): ``<provider>:<name>``.

        Raises:
            ValueError: the text names no machine.
        """
        provider, sep, name = text.partition(":")
        if not sep or not provider or not name:
            raise ValueError(f"not a machine name: {text!r}")
        return cls(provider, name)


@dataclass(frozen=True, slots=True)
class MachinePid:
    """A process's pid on its machine, with the kernel's start time,
    which tells it apart from a later process given the same pid, and
    when it exited, should it exit while what it started runs on."""

    pid: int
    started: float
    exited: float | None = None


@dataclass(frozen=True, slots=True)
class CpuShares:
    """What a machine's processors spent a moment on, in percent, each
    None where the machine does not say.
    """

    user: float
    system: float
    idle: float
    nice: float | None = None
    wait: float | None = None
    hardware: float | None = None
    software: float | None = None
    stolen: float | None = None


@dataclass(frozen=True, slots=True)
class TaskCounts:
    """How many processes a machine holds, by what they are doing; only
    ``total``, ``running`` and ``sleeping`` where it says no more.
    """

    total: int
    running: int
    sleeping: int
    stopped: int = 0
    zombie: int = 0


@dataclass(frozen=True, slots=True)
class MachineResources:
    """What one machine holds right now, in bytes where it is memory:
    ``machine`` as ``ps`` shows it; ``cpus`` the processors a program
    there may use and ``all_cpus`` those it has; ``epoch``, ``clock`` and
    ``offset`` its time as seconds, ``HH:MM:SS`` and ``+hhmm``;
    ``up_seconds`` since it booted; ``load`` its three load averages;
    ``users`` logged in. A memory figure is None where the machine has no
    such thing. ``tasks`` and ``cpu`` are read only when asked for.
    ``hostname`` is the name it calls itself and ``cpu_info`` what
    ``lscpu`` prints there, empty where it has none.
    """

    machine: str
    cpus: int
    all_cpus: int
    epoch: float
    clock: str
    offset: str
    up_seconds: float
    load: tuple[float, float, float]
    users: int
    mem_total: int
    mem_free: int
    mem_available: int
    swap_total: int
    swap_free: int
    shared: int | None = None
    buffers: int | None = None
    cached: int | None = None
    commit_limit: int | None = None
    committed: int | None = None
    low_total: int | None = None
    low_free: int | None = None
    high_total: int | None = None
    high_free: int | None = None
    tasks: TaskCounts | None = None
    cpu: CpuShares | None = None
    hostname: str = ""
    cpu_info: str = ""
