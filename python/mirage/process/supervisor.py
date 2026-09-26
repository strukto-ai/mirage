import asyncio
import time
from collections.abc import Callable
from dataclasses import replace
from threading import RLock

from mirage.process.config import ProcessPermissions, ProcessScope
from mirage.process.handle import ProcessHandle
from mirage.process.types import ProcessInfo, ProcessRunner, ProcessView
from mirage.types import PathSpec


class ProcessSupervisor:
    """Own live runners independently of shell job-table membership.

    IDs are workspace-local and never reused. Exited runners leave this
    live registry; holders of their handles retain the final result.
    """

    def __init__(self) -> None:
        self._next_pid = 1
        self._live: dict[int, tuple[int, ProcessHandle]] = {}
        self._generations: dict[str, int] = {}
        self._lock = RLock()
        self._stopped = False

    def start(self,
              *,
              session_id: str,
              command: str,
              cwd: PathSpec,
              run: ProcessRunner,
              parent_pid: int | None = None) -> ProcessHandle:
        """Track a runner; its caller owns admission before command effects.

        Args:
            session_id (str): owner session, never a profile label.
            command (str): display text, never parsed by this layer.
            cwd (PathSpec): working directory at launch.
            run (ProcessRunner): asynchronous execution and cleanup.
        """
        with self._lock:
            if self._stopped:
                raise RuntimeError("process supervisor is stopped")
            pid = self._next_pid
            self._next_pid += 1
            parent = self._live.get(
                parent_pid) if parent_pid is not None else None
            if parent_pid is not None and (
                    parent is None or parent[1].info.cancellation_requested):
                raise RuntimeError(
                    "parent process is no longer accepting children")
            group_id = parent[1].info.group_id if parent is not None else pid
            handle = ProcessHandle(
                ProcessInfo(pid,
                            session_id,
                            command,
                            cwd,
                            time.time(),
                            parent_pid=parent_pid,
                            group_id=group_id), run, self._retire,
                lambda: self.terminate_children(pid))
            self._live[pid] = (self._generations.get(session_id, 0), handle)
            return handle

    def terminate_children(self, pid: int) -> None:
        """Request cancellation of every live runner under ``pid``.

        A runner is under ``pid`` when ``pid`` is its parent or started
        its execution group, so grandchildren are reached after an
        intermediate runner has exited.

        Args:
            pid (int): the parent or group leader.
        """
        for child in self.live():
            if child.info.parent_pid == pid or (child.info.group_id == pid
                                                and child.info.pid != pid):
                child.terminate()

    def _retire(self, pid: int) -> None:
        with self._lock:
            self._live.pop(pid, None)

    def view(
        self,
        session_id: str,
        permissions: Callable[[], ProcessPermissions] = ProcessPermissions
    ) -> ProcessView:
        with self._lock:
            generation = self._generations.get(session_id, 0)

        def valid() -> bool:
            return self._generations.get(session_id, 0) == generation

        def allowed(scope: ProcessScope, handle: ProcessHandle) -> bool:
            return scope == "workspace" or (
                scope == "session" and handle.info.session_id == session_id)

        def visible(handle: ProcessHandle) -> ProcessInfo | None:
            entry = self._live.get(handle.info.pid)
            if (handle.info.session_id == session_id and entry is not None
                    and entry[0] != generation):
                return None
            grants = permissions()
            if not valid() or not allowed(grants.metadata, handle):
                return None
            info = handle.info
            return info if allowed(grants.details, handle) else replace(
                info, command=None, cwd=None, failure=None)

        def list_visible() -> tuple[ProcessInfo, ...]:
            with self._lock:
                return tuple(info for _, handle in self._live.values()
                             if (info := visible(handle)) is not None)

        def get_visible(pid: int) -> ProcessInfo | None:
            with self._lock:
                entry = self._live.get(pid)
                return visible(entry[1]) if entry is not None else None

        def check_spawn() -> None:
            if not valid() or not permissions().spawn:
                raise PermissionError("process spawn is not permitted")

        def terminate(pid: int) -> bool:
            with self._lock:
                entry = self._live.get(pid)
                if entry is None or visible(entry[1]) is None or not allowed(
                        permissions().control, entry[1]):
                    return False
                return entry[1].terminate()

        async def wait(pid: int) -> ProcessInfo | None:
            with self._lock:
                entry = self._live.get(pid)
                if entry is None or visible(entry[1]) is None:
                    return None
                handle = entry[1]
            await handle.join()
            return visible(handle)

        return ProcessView(list=list_visible,
                           get=get_visible,
                           check_spawn=check_spawn,
                           terminate=terminate,
                           wait=wait)

    def revoke_session(self, session_id: str) -> None:
        """Revoke the session's views and cancel its runners.

        A closed session's ID can be reused and a replaced profile grants
        a new view, so neither may keep a door, or a runner admitted
        under the old grants.

        Args:
            session_id (str): session being closed or re-profiled.
        """
        with self._lock:
            self._generations[session_id] = self._generations.get(
                session_id, 0) + 1
        for process in self.live():
            if process.info.session_id == session_id:
                process.terminate()

    def live(self) -> tuple[ProcessHandle, ...]:
        """Host-only inventory, including disowned and stopping runners."""
        with self._lock:
            return tuple(handle for _, handle in self._live.values())

    async def drain(self) -> None:
        """Join managed runners before releasing their workspace resources."""
        await asyncio.gather(*(process.join() for process in self.live()))

    def stop(self) -> None:
        """Close admission and request cancellation of all remaining runners.

        This does not join: uncooperative runners remain visible as stopping.
        """
        with self._lock:
            self._stopped = True
        errors: list[Exception] = []
        for process in self.live():
            try:
                process.terminate()
            except Exception as exc:
                errors.append(exc)
        if errors:
            raise ExceptionGroup("process cancellation failed", errors)
