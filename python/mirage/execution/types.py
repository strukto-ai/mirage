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
class MachineId:
    """Where a process runs: the provider that reaches the machine and
    the machine's name there, written ``docker:tools``."""

    provider: str
    name: str

    def __str__(self) -> str:
        return f"{self.provider}:{self.name}"

    @classmethod
    def parse(cls, text: str) -> "MachineId":
        """The id ``str`` wrote.

        Args:
            text (str): ``<provider>:<name>``.

        Raises:
            ValueError: the text names no machine.
        """
        provider, sep, name = text.partition(":")
        if not sep or not provider or not name:
            raise ValueError(f"not a machine id: {text!r}")
        return cls(provider, name)


@dataclass(frozen=True, slots=True)
class MachinePid:
    """A process's pid on its machine, with the kernel's start time,
    which tells it apart from a later process given the same pid, and
    when it exited, should it exit while what it started runs on."""

    pid: int
    started: float
    exited: float | None = None
