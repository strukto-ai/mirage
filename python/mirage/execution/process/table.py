import asyncio
import errno
import logging
from collections.abc import Awaitable, Callable
from threading import RLock

from mirage.execution.constants import (
    HISTORY_MAX_RECORDS,
    HISTORY_SECONDS,
    LOCAL_MACHINE,
)
from mirage.execution.process.config import ProcessPermissions, ProcessScope
from mirage.execution.process.constants import FIRST_PID
from mirage.execution.process.handle import ExecutionBind, ProcessHandle
from mirage.execution.process.types import Process, ProcessRunner, ProcessState
from mirage.execution.process.view import ProcessView
from mirage.execution.types import LineId, MachineId, ProcessId
from mirage.types import PathSpec, under_ceiling
from mirage.utils.clock import system_now

logger = logging.getLogger(__name__)


def deliver(handle: ProcessHandle, signal: int) -> None:
    """Deliver a signal to one runner of a group: one that ignores it
    hands it to the program it runs right now, any other stops with it.

    Args:
        handle (ProcessHandle): the runner.
        signal (int): the signal.
    """
    if signal in handle.ignores:
        handle.interrupt(signal)
    else:
        handle.terminate(signal, children=False)


class ProcessTable:
    """Own live runners independently of shell job-table membership.

    IDs are workspace-local and never reused. For now one daemon runs a
    workspace at a time, the one holding its lease, and numbers its pids
    on from the highest the workspace's store recorded
    (``continue_after``). Exited runners leave this live registry;
    holders of their handles retain the final result.

    Args:
        workspace_id (str): the workspace whose pids these are.
        machine (MachineId): where a process runs unless its caller
            names another, the workspace's own machine.
        bind (ExecutionBind | None): runs each process under its host's
            execution context; None runs its body as supplied.
        changed (Callable[[], None] | None): called once a runner is
            started, so whoever publishes the live runners knows to.
        now (Callable[[], float]): the epoch seconds a process starts
            at, which ``ps`` shows; the running workspace's system time
            by default.
        ended (Callable[[Process], None] | None): told each process's
            record as it ends.
        note (Callable[[Process], None] | None): told each process's
            record as it starts and each time it changes, as the
            workspace's store keeps it.
    """

    def __init__(
        self,
        workspace_id: str = "",
        machine: MachineId = LOCAL_MACHINE,
        bind: ExecutionBind | None = None,
        changed: Callable[[], None] | None = None,
        now: Callable[[], float] = system_now,
        ended: Callable[[Process], None] | None = None,
        note: Callable[[Process], None] | None = None,
    ) -> None:
        self.workspace_id = workspace_id
        self._note = note
        self.machine = machine
        self._now = now
        self._bind = bind
        self._changed = changed
        self._ended_hook = ended
        self._next_pid = FIRST_PID
        self._live: dict[int, tuple[int, ProcessHandle]] = {}
        self._ended: dict[int, tuple[int, Process]] = {}
        self._ancestors: dict[int, tuple[int, ...]] = {}
        self._generations: dict[str, int] = {}
        self._lock = RLock()
        self._stopped = False
        # The host's ceiling on any session's limit, a lifted one
        # included, whatever profile, snapshot or store set it.
        self.ceiling: int | None = None
        # Brings the table in step with what each machine runs now: the
        # processes a scan finds there join it, and leave once a scan no
        # longer sees them. The workspace sets it, since it holds the
        # machines.
        self.scanner: Callable[[], Awaitable[None]] | None = None
        # Sends a signal to a process that is a program on a machine as
        # ``kill`` sent it, answering whether it ran, or None for a
        # process Mirage stops itself. The workspace sets it.
        self.sender: (
            Callable[[ProcessHandle, int], Awaitable[bool] | None] | None
        ) = None

    def start(
        self,
        *,
        session_id: str,
        command: str,
        cwd: PathSpec,
        run: ProcessRunner,
        parent: int | None = None,
        limit: int | None = None,
        line: LineId | None = None,
        started: Callable[[ProcessHandle], None] | None = None,
        ignores: frozenset[int] = frozenset(),
        pid: int | None = None,
        own_group: bool = False,
        machine: MachineId | None = None,
        runtime: str | None = None,
        one_command: bool = False,
        program_ignores: frozenset[int] = frozenset(),
    ) -> ProcessHandle:
        """Track a runner; its caller owns admission before command effects.

        Args:
            session_id (str): owner session, never a profile label.
            command (str): display text, never parsed by this layer.
            cwd (PathSpec): working directory at launch.
            run (ProcessRunner): asynchronous execution and cleanup.
            parent (int | None): the pid of the runner this one is a
                child of.
            limit (int | None): the most runners the session may hold,
                this one included, held under ``ceiling``; None for no
                cap. Stopping runners count until they finish cleanup and
                leave the live registry. A process a scan found on a
                machine (no runtime, a machine pid) counts against its
                machine's own limits, not this one.
            line (LineId | None): the line the runner runs for; None
                takes its parent's.
            started (Callable[[ProcessHandle], None] | None): what the
                caller sets up from the process before its runner runs
                (the session's ``$$``, the shell its programs run in). A
                caller that passes it has nothing left to do first, so
                the runner then starts at once, eagerly, unless a runner
                started before it has yet to begin: runners begin in the
                order they were started, so a job's redirect lands before
                the line that started it reads the file. Without it the
                runner starts on the loop's next turn.
            ignores (frozenset[int]): the signals the runner ignores,
                which stop neither it nor what it started.
            pid (int | None): the pid to run under, a session's ``$$``
                that each of its lines takes in turn; a fresh one when
                None or when a live runner holds it.
            own_group (bool): lead a process group of its own, as
                timeout's command does, instead of joining its parent's.
            machine (MachineId | None): where its program runs; None for
                the table's machine.
            runtime (str | None): what Mirage runs its program with; None
                for Mirage itself.
            one_command (bool): it runs exactly one command, whose
                program it is (``ProcessHandle.take``).
            program_ignores (frozenset[int]): what that program ignores
                as well, where ``ignores`` is more than a shell's.

        Raises:
            BlockingIOError: the session already holds ``limit``
                runners, the EAGAIN fork(2) answers at ``ulimit -u``.
        """
        with self._lock:
            if self._stopped:
                raise RuntimeError("process table is stopped")
            limit = under_ceiling(limit, self.ceiling)
            if (
                limit is not None
                and sum(
                    1
                    for _, handle in self._live.values()
                    if handle.record.session_id == session_id
                    and (
                        handle.record.runtime is not None
                        or handle.record.machine_pid is None
                    )
                )
                >= limit
            ):
                raise BlockingIOError(
                    errno.EAGAIN, "Resource temporarily unavailable"
                )
            if pid is None or pid in self._live:
                pid = self._next_pid
            self._next_pid = max(self._next_pid, pid + 1)
            above = self._live.get(parent) if parent is not None else None
            if parent is not None and (
                above is None or above[1].record.state != ProcessState.RUNNING
            ):
                raise RuntimeError(
                    "parent process is no longer accepting children"
                )
            ancestry = (
                ()
                if parent is None
                else (*self._ancestors.get(parent, ()), parent)
            )
            handle = ProcessHandle(
                Process(
                    ProcessId(self.workspace_id, pid),
                    session_id,
                    line
                    if line is not None or above is None
                    else above[1].record.line,
                    parent,
                    above[1].record.group
                    if above is not None and not own_group
                    else pid,
                    command,
                    cwd,
                    machine or self.machine,
                    self._now(),
                    runtime,
                    ancestors=ancestry,
                ),
                run,
                lambda done: self._retire(done, handle),
                lambda signal: self.terminate_children(pid, signal),
                self._bind,
                ignores,
                self._now,
            )
            handle.one_command = one_command
            handle.program_ignores = program_ignores
            eager = started is not None and not self.queued()
            self._live[pid] = (self._generations.get(session_id, 0), handle)
            self._ancestors[pid] = ancestry
        if self._note is not None:
            handle.noted = self._note
            self._note(handle.record)
        if started is not None:
            started(handle)
        handle.start(eager=eager)
        if self._changed is not None:
            self._changed()
        return handle

    @property
    def last_pid(self) -> int:
        """The highest pid handed out so far, the one before
        ``FIRST_PID`` before the first."""
        return self._next_pid - 1

    def continue_after(self, pid: int) -> None:
        """Hand out the pids that follow past ``pid``.

        The highest pid the workspace's store recorded, read once when
        this table's daemon takes the workspace's lease, so a pid another
        daemon, or this one before a restart, gave out never repeats.

        Args:
            pid (int): the highest pid already given out.
        """
        with self._lock:
            self._next_pid = max(self._next_pid, pid + 1)

    def terminate_children(self, pid: int, signal: int = 9) -> None:
        """Request cancellation of every live runner under ``pid``.

        A runner is under ``pid`` when ``pid`` is its parent or an
        ancestor further up, so grandchildren are reached after an
        intermediate runner has exited.

        Args:
            pid (int): the parent or ancestor.
            signal (int): what the stop stands for, as the parent's.
        """
        for child in self._under(pid):
            child.terminate(signal)

    async def scan(self) -> None:
        """Bring the table in step with what each machine runs now
        (``scanner``), as ``ps`` does before it lists."""
        if self.scanner is not None:
            await self.scanner()

    def send(
        self, handle: ProcessHandle, signal: int
    ) -> Awaitable[bool] | None:
        """Send a signal to a program on a machine as ``kill`` sent it
        (``sender``): what it does with it is its own, and it ends when
        it exits.

        Args:
            handle (ProcessHandle): the runner.
            signal (int): the signal.

        Returns:
            Awaitable[bool] | None: whether it ran, once sent; None for a
            runner Mirage stops itself (``deliver``).
        """
        if self.sender is None or signal in handle.ignores:
            return None
        return self.sender(handle, signal)

    async def send_group(self, group_id: int, signal: int) -> None:
        """Send a signal a process takes and goes on to every program on
        a machine in a process group as ``send`` does, leaving Mirage's
        own runners as they are. The machines are scanned first, so what
        a program started there is in the group.

        Args:
            group_id (int): the group.
            signal (int): the signal.
        """
        await self.scan()
        members = self._members(group_id)
        sending = [self.send(member, signal) for member in members]
        await asyncio.gather(*(sent for sent in sending if sent is not None))

    async def signal_group(self, group_id: int, signal: int) -> bool:
        """Deliver a signal to every live runner of a process group, as
        killpg(2) does: a program on a machine gets it as sent
        (``send``), a runner that ignores it (a shell) hands it to the
        program it runs right now (``ProcessHandle.interrupt``), and any
        other stops with it and leaves the rest of the group to their own
        delivery. The deepest runners hear it first, so a native program
        knows the signal before the shell that waits for it stops. The
        machines are scanned first, so what a program started there is
        in the group.

        Args:
            group_id (int): the group.
            signal (int): the signal.

        Returns:
            bool: whether the group had a live runner.
        """
        await self.scan()
        members = self._members(group_id)
        await _signal_members(self, members, signal)
        return bool(members)

    def _members(self, group_id: int) -> list[ProcessHandle]:
        with self._lock:
            return sorted(
                (
                    handle
                    for _, handle in self._live.values()
                    if handle.record.group == group_id
                ),
                key=lambda handle: (
                    -len(self._ancestors.get(handle.record.pid, ()))
                ),
            )

    def _under(self, pid: int) -> list[ProcessHandle]:
        with self._lock:
            return [
                handle
                for _, handle in self._live.values()
                if pid in self._ancestors.get(handle.record.pid, ())
            ]

    def _retire(self, pid: int, handle: ProcessHandle) -> None:
        with self._lock:
            entry = self._live.get(pid)
            if entry is None or entry[1] is not handle:
                return
            del self._live[pid]
            self._ended.pop(pid, None)
            self._ended[pid] = (entry[0], handle.record)
            self._prune()
        if self._ended_hook is not None:
            try:
                self._ended_hook(handle.record)
            except Exception as exc:
                logger.debug("process %d: ended hook failed: %s", pid, exc)

    def view(
        self,
        session_id: str,
        permissions: Callable[[], ProcessPermissions] = ProcessPermissions,
    ) -> ProcessView:
        with self._lock:
            generation = self._generations.get(session_id, 0)

        def valid() -> bool:
            return self._generations.get(session_id, 0) == generation

        def allowed(scope: ProcessScope, handle: ProcessHandle) -> bool:
            return (
                scope == "workspace" or handle.record.session_id == session_id
            )

        def visible(handle: ProcessHandle) -> Process | None:
            entry = self._live.get(handle.record.pid)
            if (
                handle.record.session_id == session_id
                and entry is not None
                and entry[0] != generation
            ):
                return None
            if not valid() or not allowed(permissions().list, handle):
                return None
            return handle.record

        def list_visible() -> tuple[Process, ...]:
            with self._lock:
                return tuple(
                    info
                    for _, handle in self._live.values()
                    if (info := visible(handle)) is not None
                )

        def check_spawn() -> None:
            if not valid():
                raise PermissionError("process spawn is not permitted")

        def signal_target(pid: int) -> ProcessHandle | None:
            entry = self._live.get(pid)
            if entry is None or visible(entry[1]) is None:
                return None
            if not allowed(permissions().kill, entry[1]):
                raise PermissionError(errno.EPERM, "Operation not permitted")
            return entry[1]

        def probe(pid: int) -> bool:
            with self._lock:
                return signal_target(pid) is not None

        def terminate(pid: int, signal: int) -> bool:
            with self._lock:
                handle = signal_target(pid)
                # A session's shell leaves its jobs running, as bash's do
                # when it dies.
                return handle is not None and (
                    signal in handle.ignores
                    or handle.terminate(
                        signal, children=handle.record.parent is not None
                    )
                )

        def group(group_id: int) -> list[ProcessHandle] | None:
            members = [
                handle
                for handle in self._members(group_id)
                if visible(handle) is not None
            ]
            if not members:
                return None
            if not all(allowed(permissions().kill, h) for h in members):
                raise PermissionError(errno.EPERM, "Operation not permitted")
            return members

        def probe_group(group_id: int) -> bool:
            return group(group_id) is not None

        def send(pid: int, signal: int) -> Awaitable[bool] | None:
            with self._lock:
                handle = signal_target(pid)
            if handle is None:
                return None
            return self.send(handle, signal)

        async def signal_group(group_id: int, signal: int) -> bool:
            await self.scan()
            members = group(group_id)
            await _signal_members(self, members or [], signal)
            return members is not None

        def granted() -> ProcessPermissions | None:
            return permissions() if valid() else None

        return ProcessView(
            list=list_visible,
            check_spawn=check_spawn,
            probe=probe,
            terminate=terminate,
            permissions=granted,
            probe_group=probe_group,
            signal_group=signal_group,
            scan=self.scan,
            send=send,
        )

    def revoke_session(self, session_id: str) -> None:
        """Revoke the session's views and cancel its runners.

        A closed session's ID can be reused and a replaced profile grants
        a new view, so neither may keep an entry point, or a runner admitted
        under the old grants.

        Args:
            session_id (str): session being closed or re-profiled.
        """
        with self._lock:
            self._generations[session_id] = (
                self._generations.get(session_id, 0) + 1
            )
        for process in self.live():
            if process.record.session_id == session_id:
                process.revoked = True
                process.terminate()

    def current(self, record: Process) -> bool:
        """Whether the record the table keeps under ``record``'s pid,
        live or ended, started in its session as it is now: one closed or
        re-profiled since is not, so a session that reuses the id sees
        none of its predecessor's.

        Args:
            record (Process): the process.
        """
        with self._lock:
            live = self._live.get(record.pid)
            entry = (
                (live[0], live[1].record)
                if live is not None
                else self._ended.get(record.pid)
            )
            return (
                entry is not None
                and entry[1].session_id == record.session_id
                and entry[0] == self._generations.get(record.session_id, 0)
            )

    def live(self) -> tuple[ProcessHandle, ...]:
        """Host-only inventory, including disowned and stopping runners."""
        with self._lock:
            return tuple(handle for _, handle in self._live.values())

    def records(self) -> list[Process]:
        """The records the table keeps, by pid: every live process's,
        and the newest ended ones, ``HISTORY_MAX_RECORDS`` of them for
        ``HISTORY_SECONDS`` at most. A pid a session's lines run under
        in turn keeps its latest."""
        with self._lock:
            self._prune()
            kept = {pid: record for pid, (_, record) in self._ended.items()}
            kept.update(
                (pid, handle.record) for pid, (_, handle) in self._live.items()
            )
        return [kept[pid] for pid in sorted(kept)]

    def tree(self, pid: int) -> set[int]:
        """The pid and those of every process under it the table keeps,
        live or ended. Each is found by its whole ancestry, kept for as
        long as its record is, so a process stays under an ancestor
        whose own record has gone.

        Args:
            pid (int): the process at the root.
        """
        with self._lock:
            self._prune()
            kept = self._ended.keys() | self._live.keys()
            return {pid} | {
                other
                for other in kept
                if pid in self._ancestors.get(other, ())
            }

    def _prune(self) -> None:
        """Drop the oldest ended records past the history's bounds, and
        the ancestry of each a live process does not reuse; they are kept
        in the order they ended."""
        cutoff = self._now() - HISTORY_SECONDS
        while self._ended:
            pid, (_, record) = next(iter(self._ended.items()))
            if (
                len(self._ended) <= HISTORY_MAX_RECORDS
                and (record.ended_at or 0) > cutoff
            ):
                break
            del self._ended[pid]
            if pid not in self._live:
                self._ancestors.pop(pid, None)

    def queued(self) -> bool:
        """Whether a runner that was started has yet to begin."""
        with self._lock:
            return any(not handle.begun for _, handle in self._live.values())

    async def drain(
        self, blocked: asyncio.AbstractEventLoop | None = None
    ) -> None:
        """Join managed runners before releasing their workspace resources.

        Args:
            blocked (asyncio.AbstractEventLoop | None): a loop that is
                waiting for this drain to return (a sync ``with`` block
                exiting inside it). Its runners cannot run until then, so
                they are left to unwind from their cancellation instead
                of being joined.
        """
        await asyncio.gather(
            *(
                process.join()
                for process in self.live()
                if process.task.get_loop() is not blocked
            )
        )

    def stop(self) -> None:
        """Close admission and request cancellation of all remaining runners.

        This does not join: uncooperative runners remain visible as stopping.
        """
        with self._lock:
            self._stopped = True
        errors: list[Exception] = []
        for process in self.live():
            process.revoked = True
            try:
                process.terminate()
            except Exception as exc:
                errors.append(exc)
        if errors:
            raise ExceptionGroup("process cancellation failed", errors)


async def _signal_members(
    table: ProcessTable, members: list[ProcessHandle], signal: int
) -> None:
    """Deliver a signal to each runner of a group: the programs on
    machines as sent, a parent before its children so a shell does not
    see its child die first, and Mirage's own at once (``deliver``),
    deepest first. A runner that ignores it, a shell, hands it to the
    program it runs right now, unless a process of that program, a child
    a scan found, got it as sent.

    Args:
        table (ProcessTable): the table the runners run in.
        members (list[ProcessHandle]): the runners, deepest first.
        signal (int): the signal.
    """
    sending = {
        member.record.pid: table.send(member, signal)
        for member in reversed(members)
    }
    reached = {pid for pid, sent in sending.items() if sent is not None}
    for member in members:
        if member.record.pid not in reached and (
            signal not in member.ignores
            or not any(
                other.record.parent == member.record.pid
                and other.record.pid in reached
                for other in members
            )
        ):
            deliver(member, signal)
    await asyncio.gather(*(s for s in sending.values() if s is not None))
