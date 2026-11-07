import asyncio
import errno
from collections.abc import Callable
from threading import RLock

from mirage.execution.context import new_execution_id
from mirage.execution.process.config import ProcessPermissions, ProcessScope
from mirage.execution.process.handle import ExecutionBind, ProcessHandle
from mirage.execution.process.types import ProcessInfo, ProcessRunner
from mirage.execution.process.view import ProcessView
from mirage.types import PathSpec, under_ceiling
from mirage.utils.clock import system_now
from mirage.utils.ids import IdSource


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

    IDs are workspace-local and never reused. Exited runners leave this
    live registry; holders of their handles retain the final result.

    Args:
        ids (IdSource | None): where a process's execution id is drawn
            when its caller names none; None means the system source.
        bind (ExecutionBind | None): runs each process under its host's
            execution context; None runs its body as supplied.
        changed (Callable[[], None] | None): called once a runner is
            started, so whoever publishes the live runners knows to.
        now (Callable[[], float]): the epoch seconds a process starts
            at, which ``ps`` shows; the running workspace's system time
            by default.
    """

    def __init__(
        self,
        ids: IdSource | None = None,
        bind: ExecutionBind | None = None,
        changed: Callable[[], None] | None = None,
        now: Callable[[], float] = system_now,
    ) -> None:
        self._ids = ids
        self._now = now
        self._bind = bind
        self._changed = changed
        self._next_pid = 1
        self._live: dict[int, tuple[int, ProcessHandle]] = {}
        self._ancestors: dict[int, tuple[int, ...]] = {}
        self._generations: dict[str, int] = {}
        self._lock = RLock()
        self._stopped = False
        # The host's ceiling on any session's limit, a lifted one
        # included, whatever profile, snapshot or store set it.
        self.ceiling: int | None = None

    def start(
        self,
        *,
        session_id: str,
        command: str,
        cwd: PathSpec,
        run: ProcessRunner,
        parent_pid: int | None = None,
        limit: int | None = None,
        execution_id: str | None = None,
        started: Callable[[ProcessHandle], None] | None = None,
        ignores: frozenset[int] = frozenset(),
        pid: int | None = None,
        own_group: bool = False,
    ) -> ProcessHandle:
        """Track a runner; its caller owns admission before command effects.

        Args:
            session_id (str): owner session, never a profile label.
            command (str): display text, never parsed by this layer.
            cwd (PathSpec): working directory at launch.
            run (ProcessRunner): asynchronous execution and cleanup.
            parent_pid (int | None): the runner this one is a child of.
            limit (int | None): the most runners the session may hold,
                this one included, held under ``ceiling``; None for no
                cap. Stopping runners count until they finish cleanup and
                leave the live registry.
            execution_id (str | None): external execution identity for
                an admitted root; children receive a fresh identity.
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
                    if handle.info.session_id == session_id
                )
                >= limit
            ):
                raise BlockingIOError(
                    errno.EAGAIN, "Resource temporarily unavailable"
                )
            if pid is None or pid in self._live:
                pid = self._next_pid
            self._next_pid = max(self._next_pid, pid + 1)
            parent = (
                self._live.get(parent_pid) if parent_pid is not None else None
            )
            if parent_pid is not None and (
                parent is None or parent[1].info.cancellation_requested
            ):
                raise RuntimeError(
                    "parent process is no longer accepting children"
                )
            group_id = (
                parent[1].info.group_id
                if parent is not None and not own_group
                else pid
            )
            handle = ProcessHandle(
                ProcessInfo(
                    pid,
                    session_id,
                    command,
                    cwd,
                    self._now(),
                    execution_id=execution_id or new_execution_id(self._ids),
                    parent_pid=parent_pid,
                    group_id=group_id,
                ),
                run,
                lambda done: self._retire(done, handle),
                lambda signal: self.terminate_children(pid, signal),
                self._bind,
                ignores,
            )
            eager = started is not None and not self.queued()
            self._live[pid] = (self._generations.get(session_id, 0), handle)
            self._ancestors[pid] = (
                ()
                if parent_pid is None
                else (*self._ancestors.get(parent_pid, ()), parent_pid)
            )
        if started is not None:
            started(handle)
        handle.start(eager=eager)
        if self._changed is not None:
            self._changed()
        return handle

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

    def signal_group(self, group_id: int, signal: int) -> bool:
        """Deliver a signal to every live runner of a process group, as
        killpg(2) does: a runner that ignores it (a shell) hands it to the
        program it runs right now (``ProcessHandle.interrupt``), and any
        other stops with it and leaves the rest of the group to their own
        delivery. The deepest runners hear it first, so a native program
        knows the signal before the shell that waits for it stops.

        Args:
            group_id (int): the group.
            signal (int): the signal.

        Returns:
            bool: whether the group had a live runner.
        """
        members = self._members(group_id)
        for member in members:
            deliver(member, signal)
        return bool(members)

    def _members(self, group_id: int) -> list[ProcessHandle]:
        with self._lock:
            return sorted(
                (
                    handle
                    for _, handle in self._live.values()
                    if handle.info.group_id == group_id
                ),
                key=lambda handle: (
                    -len(self._ancestors.get(handle.info.pid, ()))
                ),
            )

    def _under(self, pid: int) -> list[ProcessHandle]:
        with self._lock:
            return [
                handle
                for _, handle in self._live.values()
                if pid in self._ancestors.get(handle.info.pid, ())
            ]

    def _retire(self, pid: int, handle: ProcessHandle) -> None:
        with self._lock:
            entry = self._live.get(pid)
            if entry is None or entry[1] is not handle:
                return
            del self._live[pid]
            self._ancestors.pop(pid, None)

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
            return scope == "workspace" or handle.info.session_id == session_id

        def visible(handle: ProcessHandle) -> ProcessInfo | None:
            entry = self._live.get(handle.info.pid)
            if (
                handle.info.session_id == session_id
                and entry is not None
                and entry[0] != generation
            ):
                return None
            if not valid() or not allowed(permissions().list, handle):
                return None
            return handle.info

        def list_visible() -> tuple[ProcessInfo, ...]:
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
                        signal, children=handle.info.parent_pid is not None
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

        def signal_group(group_id: int, signal: int) -> bool:
            members = group(group_id)
            for member in members or ():
                deliver(member, signal)
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
            if process.info.session_id == session_id:
                process.revoked = True
                process.terminate()

    def live(self) -> tuple[ProcessHandle, ...]:
        """Host-only inventory, including disowned and stopping runners."""
        with self._lock:
            return tuple(handle for _, handle in self._live.values())

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
