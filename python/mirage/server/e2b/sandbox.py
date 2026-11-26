import asyncio
import logging
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from mirage.io.pipe import BytePipe
from mirage.server.e2b.connect import StartCommand
from mirage.server.e2b.errors import SandboxNotRunning
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.workspace.shell_execution import ShellExecution

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class LiveProcess:
    command: StartCommand
    execution: ShellExecution
    stdin: BytePipe | None
    killed: bool = False

    def stop_input(self) -> None:
        if self.stdin is not None:
            self.stdin.close_reader()
            self.stdin = None


@dataclass(slots=True)
class Sandbox:
    entry: WorkspaceEntry
    session_id: str
    access_token: str = field(repr=False)
    env_vars: dict[str, str] = field(repr=False)
    expires_at: float
    expiry: asyncio.TimerHandle = field(init=False, repr=False)
    revoked: asyncio.Event = field(
        default_factory=asyncio.Event, init=False, repr=False
    )
    processes: dict[int, LiveProcess] = field(
        default_factory=dict, init=False, repr=False
    )
    _body_reads: set[Callable[[], bool]] = field(
        default_factory=set, init=False, repr=False
    )
    _files: dict[asyncio.Future[None], Callable[[], bool]] = field(
        default_factory=dict, init=False, repr=False
    )

    def check_files(self) -> None:
        if (
            not self.entry.accepting_jobs
            or self.expires_at <= asyncio.get_running_loop().time()
        ):
            raise SandboxNotRunning()

    @asynccontextmanager
    async def file_access(self) -> AsyncIterator[None]:
        self.check_files()
        task = asyncio.current_task()
        assert task is not None
        finished = asyncio.get_running_loop().create_future()
        self._files[finished] = task.cancel
        try:
            yield
        except asyncio.CancelledError as exc:
            if not self.entry.accepting_jobs:
                raise SandboxNotRunning() from exc
            raise
        finally:
            del self._files[finished]
            finished.set_result(None)

    async def read_body[T, **P](
        self,
        read: Callable[P, Awaitable[T]],
        *args: P.args,
        **kwargs: P.kwargs,
    ) -> T:
        self.check_files()
        task = asyncio.current_task()
        assert task is not None

        def cancel() -> bool:
            return task.cancel(SandboxNotRunning())

        self._body_reads.add(cancel)
        try:
            return await read(*args, **kwargs)
        except asyncio.CancelledError as exc:
            reason = exc.args[0] if exc.args else None
            if isinstance(reason, SandboxNotRunning):
                raise reason from exc
            raise
        finally:
            self._body_reads.remove(cancel)

    async def stop_files(self) -> None:
        # Body readers hold no workspace resources and may themselves call kill.
        for cancel in self._body_reads:
            cancel()
        for cancel in self._files.values():
            cancel()
        await asyncio.gather(*self._files)

    async def run_file[T, **P](
        self,
        operation: Callable[P, Awaitable[T]],
        *args: P.args,
        **kwargs: P.kwargs,
    ) -> T:
        async def dispatch() -> T:
            self.check_files()
            return await operation(*args, **kwargs)

        return await self.entry.runner.call(dispatch())


class Sandboxes:
    """Daemon-local leases and their workspace lifetimes."""

    def __init__(self, registry: WorkspaceRegistry) -> None:
        self._registry = registry
        self._leases: dict[str, Sandbox] = {}
        self._retiring: set[asyncio.Task[bool]] = set()

    def add(
        self, entry: WorkspaceEntry, env_vars: dict[str, str], timeout: int
    ) -> Sandbox:
        loop = asyncio.get_running_loop()
        lease = Sandbox(
            entry=entry,
            session_id=entry.runner.ws.default_session_id,
            access_token=secrets.token_urlsafe(32),
            env_vars=env_vars.copy(),
            expires_at=loop.time() + timeout,
        )
        lease.expiry = loop.call_at(lease.expires_at, self._expire, lease)
        self._leases[entry.id] = lease
        entry.before_stop = lambda: self._before_stop(lease)
        return lease

    def live(self, sandbox_id: str) -> Sandbox | None:
        lease = self._leases.get(sandbox_id)
        if lease is None:
            return None
        if not lease.entry.accepting_jobs or not self._registered(lease):
            self._forget(lease)
            return None
        if lease.expires_at <= asyncio.get_running_loop().time():
            self._retire(lease)
            return None
        return lease

    def reconnect(
        self, sandbox_id: str, account: str | None, timeout: int
    ) -> Sandbox | None:
        lease = self.owned(sandbox_id, account)
        if lease is None:
            return None
        deadline = asyncio.get_running_loop().time() + timeout
        if deadline > lease.expires_at:
            self._set_expiry(lease, deadline)
        return lease

    def set_timeout(
        self, sandbox_id: str, account: str | None, timeout: int
    ) -> bool:
        lease = self.owned(sandbox_id, account)
        if lease is None:
            return False
        self._set_expiry(lease, asyncio.get_running_loop().time() + timeout)
        return True

    async def kill(self, sandbox_id: str, account: str | None) -> bool | None:
        lease = self.owned(sandbox_id, account)
        if lease is None:
            return None
        return await asyncio.shield(self._retire(lease))

    async def close(self) -> None:
        for lease in list(self._leases.values()):
            self._retire(lease)
        if self._retiring:
            await asyncio.gather(*self._retiring, return_exceptions=True)

    def owned(self, sandbox_id: str, account: str | None) -> Sandbox | None:
        lease = self.live(sandbox_id)
        if lease is None or lease.entry.owner != account:
            return None
        return lease

    def _set_expiry(self, lease: Sandbox, deadline: float) -> None:
        lease.expiry.cancel()
        lease.expires_at = deadline
        lease.expiry = asyncio.get_running_loop().call_at(
            deadline, self._expire, lease
        )

    def _expire(self, lease: Sandbox) -> None:
        if self._leases.get(lease.entry.id) is not lease:
            return
        loop = asyncio.get_running_loop()
        if lease.expires_at > loop.time():
            lease.expiry = loop.call_at(lease.expires_at, self._expire, lease)
            return
        self._retire(lease)

    def _registered(self, lease: Sandbox) -> bool:
        entry = lease.entry
        return self._registry.visible(entry.id, entry.owner) is entry

    def _retire(self, lease: Sandbox) -> asyncio.Task[bool]:
        self._forget(lease)
        if self._registered(lease):
            lease.entry.accepting_jobs = False
        task = asyncio.create_task(self._remove(lease))
        self._retiring.add(task)
        task.add_done_callback(self._retiring.discard)
        return task

    def _forget(self, lease: Sandbox) -> None:
        if self._leases.get(lease.entry.id) is lease:
            del self._leases[lease.entry.id]
        lease.expiry.cancel()
        lease.revoked.set()

    async def _before_stop(self, lease: Sandbox) -> None:
        self._forget(lease)
        await lease.stop_files()

    async def _remove(self, lease: Sandbox) -> bool:
        try:
            if self._registered(lease):
                await self._registry.remove(lease.entry.id)
        except Exception:
            logger.exception("could not remove sandbox %s", lease.entry.id)
            return False
        return True
